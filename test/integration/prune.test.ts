/**
 * `prune` sweeps tombstones (jahala/umbel#73).
 *
 * `kill` keeps the session directory and `remain-on-exit` keeps the pane, so a
 * post-mortem always has something to read — and a machine that spawns workers
 * all day accumulates both. `prune` is the sweep: it removes the directories
 * and the tmux remains of sessions that are dead, and only those. A worker
 * still running is untouched, because the whole point of keeping the record is
 * lost if the sweep can take a live fleet with it.
 *
 * `--older-than` is the grace period: a tombstone younger than it stays, so a
 * conductor can sweep on a timer without racing its own post-mortem.
 *
 * Driven through the CLI face, because the flag and what the sweep reports are
 * part of the contract; the filesystem and tmux are read directly, because they
 * are what the claim is about.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSession, killSession } from '../../src/adapters/tmux.ts';
import { runCli } from '../../src/faces/cli.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

// Long enough for the pane to hold the dying line and for `wait` to settle
// `dead` and write `events/dead` before the sweep runs.
const DIE_MS = 1500;

const HOUR_MS = 60 * 60 * 1000;

let tmpDir = '';
let restoreState: (() => void) | undefined;
const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  restoreState?.();
  restoreState = undefined;
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The CLI reads its state root from the real environment, so the temp root has
// to be there as well as in the env passed to the operations.
async function newState(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-prune-'));
  const previous = process.env.UMBEL_STATE;
  restoreState = () => {
    if (previous === undefined) delete process.env.UMBEL_STATE;
    else process.env.UMBEL_STATE = previous;
  };
  process.env.UMBEL_STATE = tmpDir;
  return { UMBEL_STATE: tmpDir };
}

async function spawnFake(
  env: Record<string, string | undefined>,
  fakeEnv: Record<string, string> = {},
): Promise<string> {
  const { session } = await spawn({
    cwd: tmpDir,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      ...fakeEnv,
      FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects'),
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    },
  });
  CREATED.push(session.name);
  return session.name;
}

// A worker that dies partway through its turn: no hook fires, so `wait` finds
// the dead pane and writes the record the sweep has to find.
async function dieMidTurn(env: Record<string, string | undefined>): Promise<string> {
  const name = await spawnFake(env, { FAKE_CLAUDE_DIE_MS: String(DIE_MS) });
  const { sinceMtime } = await send({ name, prompt: 'go', env });
  const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 20_000 });
  expect(result.reason).toBe('dead');
  return name;
}

function sessionDirOf(name: string): string {
  return join(tmpDir, 'sessions', name);
}

// Move a tombstone back in time, so `--older-than` has something aged to find
// without the test sleeping through the grace period.
async function backdateDeath(name: string, ageMs: number): Promise<void> {
  const path = join(sessionDirOf(name), 'events', 'dead');
  const record = JSON.parse(await readFile(path, 'utf8')) as { at: number };
  record.at = Date.now() - ageMs;
  await writeFile(path, JSON.stringify(record, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// CLI capture
// ---------------------------------------------------------------------------

type WriteType = typeof process.stdout.write;

async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const origStdout = process.stdout.write.bind(process.stdout) as WriteType;
  const origStderr = process.stderr.write.bind(process.stderr) as WriteType;
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  let code = 1;
  try {
    code = await runCli(argv);
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('prune — dead sessions go, live ones stay', () => {
  test('removes a dead worker directory and its tmux remains, and reports it', async () => {
    const env = await newState();
    const dead = await dieMidTurn(env);
    const live = await spawnFake(env);

    // The pane outlives the process, so before the sweep the corpse is still
    // a tmux session and still a directory.
    expect(await hasSession(dead, env)).toBe(true);
    expect(existsSync(sessionDirOf(dead))).toBe(true);

    const swept = await cli(['prune']);
    expect(swept.code).toBe(0);
    // A sweep that says nothing leaves the caller guessing what it took.
    expect(swept.stdout).toContain(dead);

    expect(existsSync(sessionDirOf(dead))).toBe(false);
    expect(await hasSession(dead, env)).toBe(false);

    // The live worker keeps its session, its directory, and its turn.
    expect(await hasSession(live, env)).toBe(true);
    expect(existsSync(join(sessionDirOf(live), 'meta.json'))).toBe(true);
    const { sinceMtime } = await send({ name: live, prompt: 'hello', env });
    const result = await waitFor({ name: live, sinceMtime, env, defaultTimeoutMs: 20_000 });
    expect(result.reason).toBe('stop');
  }, 60_000);

  test('sweeps a session whose tmux session is gone entirely', async () => {
    const env = await newState();
    const name = await spawnFake(env);
    // Torn down behind umbel's back — another agent's cleanup, a reboot. There
    // is no `events/dead` to date it by, only the directory the spawn wrote.
    await killSession(name, env);
    expect(await hasSession(name, env)).toBe(false);
    expect(existsSync(sessionDirOf(name))).toBe(true);

    expect((await cli(['prune'])).code).toBe(0);

    expect(existsSync(sessionDirOf(name))).toBe(false);
  }, 60_000);

  test('--older-than keeps a fresh tombstone and takes an aged one', async () => {
    const env = await newState();
    const fresh = await dieMidTurn(env);
    const aged = await dieMidTurn(env);
    await backdateDeath(aged, 2 * HOUR_MS);

    const swept = await cli(['prune', '--older-than', '1h']);
    expect(swept.code).toBe(0);

    expect(existsSync(sessionDirOf(aged))).toBe(false);
    expect(await hasSession(aged, env)).toBe(false);

    // Inside the grace period the record is still what a post-mortem reads, so
    // neither the directory nor the pane may be taken.
    expect(existsSync(join(sessionDirOf(fresh), 'events', 'dead'))).toBe(true);
    expect(await hasSession(fresh, env)).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The reference — a lifecycle nobody can read is a lifecycle nobody relies on
// ---------------------------------------------------------------------------

const REFERENCE = join(import.meta.dir, '../../docs/cli-reference.md');

// Everything from the heading to the next one of the same or higher level.
function section(doc: string, heading: RegExp): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  expect(start).toBeGreaterThanOrEqual(0);
  const level = (lines[start] ?? '').match(/^#+/)?.[0].length ?? 3;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const hashes = line.match(/^#+/)?.[0].length;
    return hashes !== undefined && hashes <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('docs/cli-reference.md states the lifecycle', () => {
  test('the pane kept after death, exitCode on dead, the tombstone, --purge, prune', async () => {
    const doc = await readFile(REFERENCE, 'utf8');

    const lifecycle = section(doc, /^#{2,3} .*Lifecycle/i);
    expect(lifecycle).toMatch(/remain-on-exit|pane .*(outlives|kept|stays)/i);
    expect(lifecycle).toContain('tombstone');
    expect(lifecycle).toContain('--purge');
    expect(lifecycle).toContain('prune');

    // `wait` reports the exit status as a value, not only in prose.
    const wait = section(doc, /^### wait\b/);
    const deadRow = wait.split('\n').find((line) => /^\|\s*dead\s*\|/.test(line)) ?? '';
    expect(deadRow).toContain('exitCode');

    const kill = section(doc, /^### kill\b/);
    expect(kill).toContain('--purge');

    const prune = section(doc, /^### prune\b/);
    expect(prune).toContain('--older-than');
  });
});
