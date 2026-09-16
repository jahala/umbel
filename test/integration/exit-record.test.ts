/**
 * The exit record is umbel's own (jahala/umbel#73, #91).
 *
 * On ubuntu's tmux 3.4 a dead pane reported neither the status nor the signal
 * of the fake's deaths, while macOS tmux 3.6b reported both. So the record
 * cannot come from tmux: umbel launches the worker through its own wrapper,
 * which writes `events/exit` at the moment the process ends. The dead path,
 * `kill`'s tombstone and `status` read that record first and tmux only as a
 * fallback.
 *
 * The ubuntu semantics are reproduced on any machine: the tmux dep is the real
 * adapter, except that a dead pane reports neither exitCode nor signal. Every
 * worker below is a real fake in a real tmux pane.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tmux from '../../src/adapters/tmux.ts';
import { kill } from '../../src/operations/kill.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { status } from '../../src/operations/status.ts';
import { type WaitResult, waitFor } from '../../src/operations/wait.ts';

const DIE_MS = 1000;

// tmux as ubuntu's 3.4 answered: the pane is dead, and how it died is not said.
const tmuxRecordingNothing = {
  ...tmux,
  paneState: async (
    name: string,
    env: Record<string, string | undefined> = {},
  ): Promise<tmux.PaneState> => {
    const pane = await tmux.paneState(name, env);
    if (!pane.dead) return pane;
    const { exitCode: _exitCode, signal: _signal, ...rest } = pane;
    return rest;
  },
};
const deps = { tmux: tmuxRecordingNothing };

let tmpDir = '';
const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => tmux.killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

async function newState(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-exit-record-'));
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
    deps,
  });
  CREATED.push(session.name);
  return session.name;
}

async function readEvent(name: string, file: 'exit' | 'dead'): Promise<Record<string, unknown>> {
  const raw = await readFile(join(tmpDir, 'sessions', name, 'events', file), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function dieMidTurnAndWait(
  fakeEnv: Record<string, string>,
): Promise<{ name: string; env: Record<string, string | undefined>; result: WaitResult }> {
  const env = await newState();
  const name = await spawnFake(env, { FAKE_CLAUDE_DIE_MS: String(DIE_MS), ...fakeEnv });
  const { sinceMtime } = await send({ name, prompt: 'go', env, deps });
  const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 20_000, deps });
  return { name, env, result };
}

async function untilPaneDead(name: string, env: Record<string, string | undefined>) {
  const by = Date.now() + 15_000;
  while (Date.now() < by) {
    if ((await tmuxRecordingNothing.paneState(name, env)).dead) return;
    await Bun.sleep(100);
  }
  throw new Error(`pane of ${name} never died`);
}

describe('events/exit — the wrapper records how the worker ended', () => {
  test('an exit status is recorded and read as such when tmux records nothing', async () => {
    const { name, env, result } = await dieMidTurnAndWait({ FAKE_CLAUDE_EXIT_CODE: '3' });

    expect(result.reason).toBe('dead');
    expect(result.exitCode).toBe(3);
    expect(result.message).toBe('process exited 3');
    expect(result.paneSnapshot).toContain('dying now');

    expect(await readEvent(name, 'exit')).toEqual({ exitCode: 3 });

    expect((await readEvent(name, 'dead')).exitCode).toBe(3);

    const [entry] = await status({ name, env, deps });
    expect(entry?.alive).toBe(false);
    expect(entry?.dead?.exitCode).toBe(3);
  }, 40_000);

  test('a death by SIGTERM is recorded by name, with no exit status', async () => {
    const { name, env, result } = await dieMidTurnAndWait({ FAKE_CLAUDE_DIE_SIGNAL: 'TERM' });

    expect(result.reason).toBe('dead');
    expect(result.exitCode).toBeUndefined();
    expect(result.message).toBe('killed by SIGTERM');

    expect(await readEvent(name, 'exit')).toEqual({ signal: 'SIGTERM' });

    expect((await readEvent(name, 'dead')).exitCode).toBeUndefined();

    const [entry] = await status({ name, env, deps });
    expect(entry?.alive).toBe(false);
    expect(entry?.dead?.exitCode).toBeUndefined();
  }, 40_000);
});

describe('status and kill read the record for a death nobody waited on', () => {
  test('status names the exit and the tombstone carries it', async () => {
    const env = await newState();
    const name = await spawnFake(env, {
      FAKE_CLAUDE_DIE_MS: String(DIE_MS),
      FAKE_CLAUDE_EXIT_CODE: '3',
    });
    await send({ name, prompt: 'go', env, deps });
    await untilPaneDead(name, env);

    const [entry] = await status({ name, env, deps });
    expect(entry?.alive).toBe(false);
    expect(entry?.dead?.exitCode).toBe(3);

    await kill({ name, env, deps });
    const dead = await readEvent(name, 'dead');
    expect(dead.by).toBe('kill');
    expect(dead.exitCode).toBe(3);
  }, 40_000);

  test('kill of a live worker still writes the tombstone', async () => {
    const env = await newState();
    const name = await spawnFake(env);

    const before = Date.now();
    await kill({ name, env, deps });

    expect(await tmux.hasSession(name, env)).toBe(false);
    const dead = await readEvent(name, 'dead');
    expect(dead.by).toBe('kill');
    expect(dead.at as number).toBeGreaterThanOrEqual(before);
    expect(String(dead.paneSnapshot ?? '')).toContain('fake-claude ready');
  }, 40_000);
});
