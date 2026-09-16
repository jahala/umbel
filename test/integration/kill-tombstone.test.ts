/**
 * `kill` leaves a tombstone (jahala/umbel#73).
 *
 * The callers that kill a worker are the ones that most need its record: a
 * conductor kills on failure, and on 2026-09-08 that erased the only account of
 * why two codex workers died. So `kill` reads the pane while it is still there,
 * writes `events/dead` with how the session ended, and keeps the directory.
 * `--purge` is the opt-out for callers that want the space back.
 *
 * What survives is what a post-mortem asks for: `capture` answers from the pane
 * while it remains and from the record once the pane is gone, and `logs`,
 * `actions` and `read` keep answering out of the kept directory.
 *
 * Driven through the CLI face, because `--purge` is part of the contract and the
 * answers a post-mortem reads are the ones printed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSession, killSession } from '../../src/adapters/tmux.ts';
import { runCli } from '../../src/faces/cli.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

// Long enough that the pane holds the dying line and `wait` has settled `dead`
// before the kill, so the kill is tested against a record that already exists.
const DIE_MS = 1500;

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
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-kill-tombstone-'));
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
// the dead pane and writes the record the kill must not throw away.
async function dieMidTurn(
  env: Record<string, string | undefined>,
  fakeEnv: Record<string, string> = {},
): Promise<string> {
  const name = await spawnFake(env, { FAKE_CLAUDE_DIE_MS: String(DIE_MS), ...fakeEnv });
  const { sinceMtime } = await send({ name, prompt: 'go', env });
  const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 20_000 });
  expect(result.reason).toBe('dead');
  return name;
}

async function completeTurn(
  env: Record<string, string | undefined>,
  prompt: string,
): Promise<string> {
  const name = await spawnFake(env);
  const { sinceMtime } = await send({ name, prompt, env });
  const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 20_000 });
  expect(result.reason).toBe('stop');
  return name;
}

// ---------------------------------------------------------------------------
// The record on disk — read raw, so the test sees the file and not a parser
// ---------------------------------------------------------------------------

interface DeadRecord {
  at: number;
  by?: string;
  exitCode?: number;
  paneSnapshot?: string;
}

async function readDeadRecord(name: string): Promise<DeadRecord> {
  const raw = await readFile(join(tmpDir, 'sessions', name, 'events', 'dead'), 'utf8');
  return JSON.parse(raw) as DeadRecord;
}

function sessionDirOf(name: string): string {
  return join(tmpDir, 'sessions', name);
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
// kill — the tombstone
// ---------------------------------------------------------------------------

describe('kill — the session directory is a tombstone', () => {
  test('records how a live worker ended, with the pane read before teardown', async () => {
    const env = await newState();
    const name = await spawnFake(env);

    const before = Date.now();
    expect((await cli(['kill', name])).code).toBe(0);

    expect(await hasSession(name, env)).toBe(false);
    expect(existsSync(join(sessionDirOf(name), 'meta.json'))).toBe(true);

    const dead = await readDeadRecord(name);
    expect(dead.by).toBe('kill');
    expect(dead.at).toBeGreaterThanOrEqual(before);
    expect(dead.at).toBeLessThanOrEqual(Date.now());
    // The pane was read while the session still stood — afterwards there is
    // nothing to read.
    expect(dead.paneSnapshot ?? '').toContain('fake-claude ready');
  }, 40_000);

  test('--purge removes the session directory', async () => {
    const env = await newState();
    const name = await spawnFake(env);

    expect((await cli(['kill', name, '--purge'])).code).toBe(0);

    expect(await hasSession(name, env)).toBe(false);
    expect(existsSync(sessionDirOf(name))).toBe(false);
  }, 40_000);

  test('keeps what wait already observed and adds who did the killing', async () => {
    const env = await newState();
    const name = await dieMidTurn(env, { FAKE_CLAUDE_EXIT_CODE: '3' });

    expect((await cli(['kill', name])).code).toBe(0);

    const dead = await readDeadRecord(name);
    expect(dead.by).toBe('kill');
    // The exit status and the dying screen are the worker's, not the kill's;
    // the kill only adds its own hand to the record.
    expect(dead.exitCode).toBe(3);
    expect(dead.paneSnapshot ?? '').toContain('dying now');
  }, 40_000);
});

// ---------------------------------------------------------------------------
// capture — the last screen, from the pane and then from the record
// ---------------------------------------------------------------------------

describe('capture — a dead worker still shows its last screen', () => {
  test('from the pane while it remains, from events/dead once it is gone', async () => {
    const env = await newState();
    const name = await dieMidTurn(env, { FAKE_CLAUDE_EXIT_CODE: '3' });

    const fromPane = await cli(['capture', name]);
    expect(fromPane.code).toBe(0);
    expect(fromPane.stdout).toContain('dying now');

    expect((await cli(['kill', name])).code).toBe(0);

    const fromRecord = await cli(['capture', name]);
    expect(fromRecord.code).toBe(0);
    expect(fromRecord.stdout).toContain('dying now');
    // The answer is a record, not a live pane, and says which.
    expect(fromRecord.stderr).toContain('events/dead');
  }, 40_000);
});

// ---------------------------------------------------------------------------
// logs, actions, read — answered from the kept directory
// ---------------------------------------------------------------------------

describe('a killed session still answers for the turn it did', () => {
  test('logs, actions and read all answer after the kill', async () => {
    const env = await newState();
    const name = await completeTurn(env, 'hello');

    expect((await cli(['kill', name])).code).toBe(0);

    const logs = await cli(['logs', name]);
    expect(logs.code).toBe(0);
    // stop.sh appends a nanosecond timestamp per end-of-turn.
    expect(logs.stdout.trim()).toMatch(/^\d+$/m);

    const acted = await cli(['actions', name]);
    expect(acted.code).toBe(0);
    expect(acted.stdout).toContain('Response to: hello');

    const transcript = await cli(['read', name]);
    expect(transcript.code).toBe(0);
    expect(transcript.stdout).toContain('Response to: hello');
  }, 40_000);
});
