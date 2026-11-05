/**
 * jahala/umbel#167 end to end: opencode's plugin fires its stop on
 * session.status idle, and idle can land before the turn's final message is on
 * disk. A conductor that trusted that stop sent a follow-up and interrupted a
 * worker that was still finishing, so wait must hold the stop until the export
 * shows a completed reply.
 *
 * The fake fires the stop immediately, keeps `export` on a mid-turn shape, and
 * replaces it with a completed message only after a delay. A wait that trusts
 * the stop alone returns within milliseconds; one that reads the export waits
 * for the handback.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_OPENCODE = join(import.meta.dir, '..', 'fixtures', 'fake-opencode.sh');
const RUN_ID = randomBytes(4).toString('hex');

// Longer than the time a stop alone would take to settle, and longer than the
// read-at-stop poll, so a wait that reads the export cannot return before it.
const FINAL_AFTER_MS = 1500;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(['bun', 'run', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

interface Worker {
  name: string;
  env: Record<string, string>;
  root: string;
}

const CREATED: Worker[] = [];

afterEach(async () => {
  await Promise.all(
    CREATED.splice(0).map(async (w) => {
      await killSession(w.name, w.env).catch(() => undefined);
      await rm(w.root, { recursive: true, force: true });
    }),
  );
});

async function spawnOpencode(fakeEnv: Record<string, string> = {}): Promise<Worker> {
  const root = await mkdtemp(join(tmpdir(), 'umbel-oc-turn-end-'));
  const state = join(root, 'state');
  const cwd = join(root, 'cwd');
  const xdg = join(root, 'xdg');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(state), mkdir(cwd), mkdir(xdg), mkdir(bin)]);

  // `opencode export` runs from this CLI process, not from the worker, so the
  // export path is served by a shim on PATH rather than by the worker binary.
  const shim = join(bin, 'opencode');
  await Bun.write(shim, `#!/usr/bin/env bash\nexec "${FAKE_OPENCODE}" "$@"\n`);
  await chmod(shim, 0o755);

  const exportFile = join(root, 'export.json');
  const name = `t${RUN_ID}${CREATED.length}`;
  const env: Record<string, string> = {
    UMBEL_STATE: state,
    XDG_CONFIG_HOME: xdg,
    UMBEL_CLAUDE_BIN: FAKE_OPENCODE,
    FAKE_OPENCODE_EXPORT_FILE: exportFile,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  // The worker inherits no FAKE_* variable on its own (umbel#93), so the two it
  // needs ride in by name.
  const workerVars = { FAKE_OPENCODE_EXPORT_FILE: exportFile, ...fakeEnv };
  const envFlags = Object.entries(workerVars).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

  const spawned = await runCli(
    ['spawn', '--provider', 'opencode', '--name', name, '--cwd', cwd, ...envFlags],
    env,
  );
  expect(spawned.stderr).toBe('');
  expect(spawned.code).toBe(0);
  const worker = { name, env, root };
  CREATED.push(worker);
  return worker;
}

interface WaitPayload {
  reason?: string;
  message?: string;
}

async function waitForTurn(w: Worker): Promise<{ payload: WaitPayload; elapsedMs: number }> {
  const sent = await runCli(['send', '--json', w.name, 'do the work'], w.env);
  expect(sent.code).toBe(0);
  const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };

  const started = Date.now();
  const waited = await runCli(
    ['wait', '--json', '--since', String(sinceMtime), '--timeout', '20s', w.name],
    w.env,
  );
  const elapsedMs = Date.now() - started;
  expect(waited.code).toBe(0);
  return { payload: JSON.parse(waited.stdout.trim()) as WaitPayload, elapsedMs };
}

describe('umbel wait on an opencode stop that precedes the handback', () => {
  test('the stop is held until the export holds the final message', async () => {
    const w = await spawnOpencode({ FAKE_OPENCODE_FINAL_AFTER_MS: String(FINAL_AFTER_MS) });

    const { payload, elapsedMs } = await waitForTurn(w);

    expect(payload.reason).toBe('stop');
    // The handback arrived, so no lag is reported.
    expect(payload.message).toBeUndefined();
    // The stop alone would have settled this in milliseconds; the final export
    // appears only after the delay, so the wait cannot have returned before it.
    expect(elapsedMs).toBeGreaterThanOrEqual(FINAL_AFTER_MS - 500);

    const read = await runCli(['read', w.name], w.env);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('the final report');
  }, 60_000);

  test('a turn that ends with no final message is reported, not handed back as done', async () => {
    const w = await spawnOpencode();

    const { payload, elapsedMs } = await waitForTurn(w);

    expect(payload.reason).toBe('stop');
    expect(payload.message).toContain('not in the transcript');
    // It held for the whole settle window rather than trusting the stop.
    expect(elapsedMs).toBeGreaterThanOrEqual(4000);
  }, 60_000);
});
