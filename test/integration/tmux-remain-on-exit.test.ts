/**
 * The pane outlives the process (jahala/umbel#73).
 *
 * tmux reaps a session the moment its last pane's process exits, so a worker
 * that died took its screen and its exit status with it: `capture` said no
 * server was running and the only record of the death was whatever a wait had
 * sampled while it still lived. With `remain-on-exit` the pane stays, holding
 * the exact final screen and `#{pane_dead_status}`.
 *
 * That moves liveness: `has-session` is now true for a worker whose process is
 * gone, so a probe that reads it reports a corpse as alive. `spawn`'s startup
 * check and `wait`'s liveness probe read `paneState` instead — a session that
 * exists with a dead pane is dead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capturePane,
  hasSession,
  killSession,
  listSessions,
  newSession,
  paneState,
} from '../../src/adapters/tmux.ts';
import { SessionNotCreatedError } from '../../src/core/errors.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-remain-test-'));
  return { UMBEL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

// The process exits on its own and tmux marks the pane dead a moment later, so
// poll rather than sleep: the assertions read the settled state instead of
// racing the server. Gives up at the deadline and hands back the last state,
// so a failure reports what was actually seen.
async function settledPaneState(
  name: string,
  timeoutMs = 5_000,
): Promise<Awaited<ReturnType<typeof paneState>>> {
  const deadline = Date.now() + timeoutMs;
  let state = await paneState(name);
  while (!state.dead && Date.now() < deadline) {
    await Bun.sleep(50);
    state = await paneState(name);
  }
  return state;
}

// ---------------------------------------------------------------------------
// The adapter: the pane, its last screen and its exit status survive the process
// ---------------------------------------------------------------------------

describe('paneState — a pane outlives its process', () => {
  test('keeps the session, the final screen and the exit status', async () => {
    const name = sessionName('dead');
    CREATED.push(name);
    await newSession({ name, cwd: '/tmp', cmd: ['sh', '-c', 'echo hi; exit 3'] });

    expect(await settledPaneState(name)).toEqual({ exists: true, dead: true, exitCode: 3 });
    // The whole point of the remains: the session is still there to read from.
    expect(await hasSession(name)).toBe(true);
    expect(await capturePane(name, 50)).toContain('hi');
  });

  test('killSession takes the remains with it', async () => {
    const name = sessionName('killed');
    CREATED.push(name);
    await newSession({ name, cwd: '/tmp', cmd: ['sh', '-c', 'echo hi; exit 3'] });
    expect((await settledPaneState(name)).dead).toBe(true);

    await killSession(name);

    expect(await hasSession(name)).toBe(false);
    expect((await paneState(name)).exists).toBe(false);
  });

  test('a running worker is not dead and has no exit status', async () => {
    const name = sessionName('live');
    CREATED.push(name);
    await newSession({ name, cwd: '/tmp', cmd: ['sh', '-c', 'sleep 30'] });

    const state = await paneState(name);
    expect(state.exists).toBe(true);
    expect(state.dead).toBe(false);
    expect(state.exitCode).toBeUndefined();
  });

  // tmux 3.6 answers `display-message -p -t <unknown>` with an empty string and
  // exit 0 rather than an error, so a paneState that trusted the exit status
  // would report a session that never existed as alive.
  test('a session that was never created does not exist', async () => {
    expect((await paneState(`no-such-session-${RUN_ID}`)).exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wait: liveness is the pane, not the session
// ---------------------------------------------------------------------------

describe("waitFor — liveness reads the worker's pane", () => {
  test('settles dead once the process exits, while the session remains', async () => {
    const env = await setup();
    const name = sessionName('waitdead');
    CREATED.push(name);
    await newSession({ name, cwd: '/tmp', cmd: ['sh', '-c', 'echo bye; exit 3'] });

    expect((await settledPaneState(name)).dead).toBe(true);
    // The premise this test exists for: the session outlives the worker, so
    // `has-session` says alive and only the pane tells the truth.
    expect(await hasSession(name)).toBe(true);

    const start = Date.now();
    const result = await waitFor({ name, sinceMtime: Date.now(), env, defaultTimeoutMs: 5_000 });

    expect(result.reason).toBe('dead');
    expect(result.stopped).toBe(false);
    // Settled by the liveness probe, not by the timeout underneath it.
    expect(Date.now() - start).toBeLessThan(2_500);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// spawn: a worker that dies during startup is not a worker
// ---------------------------------------------------------------------------

describe('spawn — the startup check reads the pane', () => {
  test('refuses a worker that exited at startup, naming its exit status', async () => {
    const env = await setup();
    const name = sessionName('exitstart');
    CREATED.push(name);

    let caught: unknown;
    try {
      await spawn({
        name,
        cwd: '/tmp',
        claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
        env: {
          ...env,
          FAKE_CLAUDE_EXIT_AT_START: '3',
          FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects'),
          FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SessionNotCreatedError);
    // The exit status is the whole diagnosis, so it reaches the caller as a
    // value and not only as prose.
    expect((caught as SessionNotCreatedError).exitCode).toBe(3);
    expect((caught as Error).message).toMatch(/\b3\b/);

    // A failed spawn still unwinds: no remains on the socket, no state on disk.
    expect(await listSessions()).not.toContain(name);
    await expect(stat(join(tmpDir, 'sessions', name))).rejects.toThrow();
  }, 30_000);
});
