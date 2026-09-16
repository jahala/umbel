/**
 * A worker that dies mid-turn leaves its evidence (jahala/umbel#73).
 *
 * The pane outlives the process, so the death is read rather than inferred:
 * `wait` settles `dead` carrying the exit status as a value, a message naming
 * it, and the pane's final screen captured from the dead pane — not the
 * throttled sample `wait` keeps while the worker is alive, which is at most a
 * couple of seconds behind and so misses the dying breath. The same three
 * things go to `events/dead`, so the session directory is the post-mortem, and
 * `status` and `ls` name the status instead of saying only `dead`.
 *
 * A death by signal is the same class: the 2026-09-08 incident was workers
 * killed by another agent. tmux records no exit status for one, so the status
 * has to be read as a signal rather than parsed into a number.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePane, killSession } from '../../src/adapters/tmux.ts';
import { runCli } from '../../src/faces/cli.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { status } from '../../src/operations/status.ts';
import { type WaitResult, waitFor } from '../../src/operations/wait.ts';

// Far enough into the turn that `wait` has taken — and let go stale — the pane
// sample it keeps while the worker is alive (refreshed every 2s), so a snapshot
// holding the dying line can only have come from the dead pane.
const DIE_MS = 3000;

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

interface DeadEvent {
  at: number;
  exitCode?: number;
  paneSnapshot?: string;
}

async function readDeadEvent(name: string): Promise<DeadEvent> {
  const raw = await readFile(join(tmpDir, 'sessions', name, 'events', 'dead'), 'utf8');
  return JSON.parse(raw) as DeadEvent;
}

// Spawn a fake worker, give it a prompt, and wait out the death it dies partway
// through the turn. No hook fires, so only the pane records what happened.
async function dieMidTurn(fakeEnv: Record<string, string>): Promise<{
  name: string;
  env: Record<string, string | undefined>;
  result: WaitResult;
}> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-dead-evidence-'));
  const env = { UMBEL_STATE: tmpDir };
  // The CLI reads its state root from the real environment.
  const previous = process.env.UMBEL_STATE;
  restoreState = () => {
    if (previous === undefined) delete process.env.UMBEL_STATE;
    else process.env.UMBEL_STATE = previous;
  };
  process.env.UMBEL_STATE = tmpDir;

  const { session } = await spawn({
    cwd: '/tmp',
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      ...fakeEnv,
      FAKE_CLAUDE_DIE_MS: String(DIE_MS),
      FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects'),
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    },
  });
  CREATED.push(session.name);

  const { sinceMtime } = await send({ name: session.name, prompt: 'go', env });
  const result = await waitFor({
    name: session.name,
    sinceMtime,
    env,
    defaultTimeoutMs: 20_000,
  });
  return { name: session.name, env, result };
}

type WriteType = typeof process.stdout.write;

async function cliStdout(argv: string[]): Promise<string> {
  let out = '';
  const original = process.stdout.write.bind(process.stdout) as WriteType;
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    out += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  try {
    await runCli(argv);
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe('waitFor — a death is settled with what was observed', () => {
  test('carries the exit status and the dead pane, and writes events/dead', async () => {
    const before = Date.now();
    const { name, env, result } = await dieMidTurn({ FAKE_CLAUDE_EXIT_CODE: '3' });

    expect(result.reason).toBe('dead');
    expect(result.stopped).toBe(false);
    // The exit status reaches the caller as a value, not only as prose.
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/\b3\b/);

    // Exact: the screen the dead pane still holds. The sample kept from while
    // the worker was alive predates the dying line.
    expect(result.paneSnapshot).toContain('dying now');
    expect((result.paneSnapshot ?? '').trimEnd()).toBe(
      (await capturePane(name, 30, env)).trimEnd(),
    );

    const dead = await readDeadEvent(name);
    expect(dead.exitCode).toBe(3);
    expect(dead.paneSnapshot).toContain('dying now');
    expect(dead.at).toBeGreaterThanOrEqual(before);
    expect(dead.at).toBeLessThanOrEqual(Date.now());
  }, 40_000);

  test('status and ls name the exit status', async () => {
    const { name, env, result } = await dieMidTurn({ FAKE_CLAUDE_EXIT_CODE: '42' });
    expect(result.reason).toBe('dead');

    const [entry] = await status({ name, env });
    expect(entry?.alive).toBe(false);
    expect(entry?.dead?.exitCode).toBe(42);

    expect(await cliStdout(['status', name])).toContain('dead (exit 42)');
    expect(await cliStdout(['ls'])).toContain('dead (exit 42)');
  }, 40_000);

  test('a worker killed by a signal is dead by that signal, with no exit status', async () => {
    const { name, result } = await dieMidTurn({ FAKE_CLAUDE_DIE_SIGNAL: 'TERM' });

    expect(result.reason).toBe('dead');
    expect(result.exitCode).toBeUndefined();
    expect(result.message).toContain('SIGTERM');
    expect(result.paneSnapshot).toContain('dying now');

    const dead = await readDeadEvent(name);
    expect(dead.exitCode).toBeUndefined();
    expect(dead.paneSnapshot).toContain('dying now');

    // Nothing to parse into a number, so nothing may print as one.
    const listed = await cliStdout(['ls']);
    expect(listed).toContain('dead');
    expect(listed).not.toContain('NaN');
  }, 40_000);
});
