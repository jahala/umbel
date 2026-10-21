/**
 * jahala/umbel#116 end to end: the first prompt sent after spawn lands, or the
 * send fails.
 *
 * Real opencode 1.18.18 opens an asynchronous autoupdate modal seconds after
 * launch and keeps it up until it is answered. The modal holds the keyboard, so
 * the first pasted prompt and its Enter go to it: the input box stays empty and
 * no turn starts, while `send` reported success. The fake reproduces that with
 * FAKE_OPENCODE_SWALLOW_FIRST_INPUT (the prompt reaches no turn), and the plugin
 * elsewhere touches events/turn-start when a submitted prompt starts a turn.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_OPENCODE = join(import.meta.dir, '..', 'fixtures', 'fake-opencode.sh');
const RUN_ID = randomBytes(4).toString('hex');

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

async function spawnOpencode(fakeEnv: Record<string, string>): Promise<Worker> {
  const root = await mkdtemp(join(tmpdir(), 'umbel-oc-first-'));
  const state = join(root, 'state');
  const cwd = join(root, 'cwd');
  const xdg = join(root, 'xdg');
  await Promise.all([mkdir(state), mkdir(cwd), mkdir(xdg)]);
  const name = `f${RUN_ID}${CREATED.length}`;
  const env: Record<string, string> = {
    UMBEL_STATE: state,
    XDG_CONFIG_HOME: xdg,
    UMBEL_CLAUDE_BIN: FAKE_OPENCODE,
  };
  const envFlags = Object.entries(fakeEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

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

describe('umbel spawn/send with opencode — the first prompt lands, or the send fails', () => {
  test('the first send right after spawn exits 0 and its turn reaches stop', async () => {
    const w = await spawnOpencode({});

    const sent = await runCli(['send', '--json', w.name, 'say hello'], w.env);
    expect(sent.stderr).toBe('');
    expect(sent.code).toBe(0);
    const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };

    const waited = await runCli(
      ['wait', '--json', '--since', String(sinceMtime), '--timeout', '20s', w.name],
      w.env,
    );
    expect(JSON.parse(waited.stdout.trim())).toMatchObject({ reason: 'stop' });
    expect(waited.code).toBe(0);
  }, 60_000);

  test('a first prompt the TUI drops makes send exit 1 naming the worker, never 0', async () => {
    const w = await spawnOpencode({ FAKE_OPENCODE_SWALLOW_FIRST_INPUT: '1' });

    const sent = await runCli(['send', w.name, 'say hello'], w.env);

    expect(sent.code).toBe(1);
    expect(sent.stdout).toBe('');
    expect(sent.stderr).toContain(w.name);
    expect(sent.stderr).toMatch(/turn/i);
  }, 60_000);

  test('a dropped first prompt does not stop the second send from landing', async () => {
    const w = await spawnOpencode({ FAKE_OPENCODE_SWALLOW_FIRST_INPUT: '1' });

    const first = await runCli(['send', w.name, 'this one is lost'], w.env);
    expect(first.code).toBe(1);

    const second = await runCli(['send', '--json', w.name, 'this one lands'], w.env);
    expect(second.stderr).toBe('');
    expect(second.code).toBe(0);
    const { sinceMtime } = JSON.parse(second.stdout) as { sinceMtime: number };

    const waited = await runCli(
      ['wait', '--json', '--since', String(sinceMtime), '--timeout', '20s', w.name],
      w.env,
    );
    expect(JSON.parse(waited.stdout.trim())).toMatchObject({ reason: 'stop' });
  }, 60_000);
});
