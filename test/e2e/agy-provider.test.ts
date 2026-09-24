import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// An agy worker, driven over its stream-json print mode (umbel#113), as a
// conductor sees it through the CLI. The pane runs the fake agy inside the
// stream wrapper: a prompt is typed as one JSON line, the stdout is the
// transcript, and each `result` line fires the stop hook.

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_AGY = join(import.meta.dir, '..', 'fixtures', 'fake-agy.sh');
const RUN_ID = randomBytes(4).toString('hex');

async function runCli(args: string[], env: Record<string, string>) {
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
  cwd: string;
  argsLog: string;
}

const CREATED: Worker[] = [];
let seq = 0;

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((w) => runCli(['kill', w.name], w.env)));
});

async function spawnAgy(extraArgs: string[] = [], fakeEnv: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'umbel-agy-'));
  const state = join(root, 'state');
  const cwd = join(root, 'cwd');
  await Promise.all([mkdir(state), mkdir(cwd)]);
  const name = `ag${RUN_ID}${seq++}`;
  const argsLog = join(root, 'args.log');
  const env: Record<string, string> = { UMBEL_STATE: state, UMBEL_CLAUDE_BIN: FAKE_AGY };
  const workerEnv: Record<string, string> = { FAKE_AGY_ARGS_LOG: argsLog, ...fakeEnv };
  const envFlags = Object.entries(workerEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const spawned = await runCli(
    ['spawn', '--name', name, '--cwd', cwd, '--provider', 'agy', ...extraArgs, ...envFlags],
    env,
  );
  const worker = { name, env, cwd, argsLog };
  CREATED.push(worker);
  return { worker, spawned };
}

async function turn(w: Worker, prompt: string) {
  const sent = await runCli(['send', '--json', w.name, prompt], w.env);
  expect(sent.stderr).toBe('');
  expect(sent.code).toBe(0);
  const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };
  const waited = await runCli(
    ['wait', '--json', '--since', String(sinceMtime), '--timeout', '20s', w.name],
    w.env,
  );
  expect(waited.code).toBe(0);
  expect((JSON.parse(waited.stdout.trim()) as { reason: string }).reason).toBe('stop');
  return (await runCli(['read', w.name], w.env)).stdout.trimEnd();
}

describe('umbel with --provider agy', () => {
  test('spawn launches agy in stream-json print mode, in the worker cwd, unattended', async () => {
    const { worker, spawned } = await spawnAgy(['--unattended']);

    expect(spawned.stderr).toBe('');
    expect(spawned.code).toBe(0);
    const argv = (await readFile(worker.argsLog, 'utf8')).split('\n').slice(0, -1);
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(realpathSync(worker.cwd));
    expect(argv[argv.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(argv.at(-1)).toBe('-p=');
  }, 30_000);

  test('a long multi-line prompt reaches agy whole, and read returns the turn it ended', async () => {
    const { worker, spawned } = await spawnAgy();
    expect(spawned.code).toBe(0);
    const prompt = `Review this "diff":\n${'x'.repeat(3000)}\nand say ok.`;

    expect(await turn(worker, prompt)).toBe(`fake agy reply: ${prompt}`);
    expect(await turn(worker, 'second')).toBe('fake agy reply: second');

    const actions = await runCli(['actions', '--json', worker.name], worker.env);
    expect(actions.code).toBe(0);
    const manifest = JSON.parse(actions.stdout) as { bashCommands: string[]; turnCount: number };
    expect(manifest.turnCount).toBe(2);
    expect(manifest.bashCommands).toEqual(['pwd', 'pwd']);
  }, 60_000);

  test('a turn agy ends with an error still stops, and read returns the error', async () => {
    const { worker } = await spawnAgy([], { FAKE_AGY_ERROR: '1' });

    expect(await turn(worker, 'go')).toBe('fake agy failure');
  }, 30_000);

  test('spawn refuses an agy that opens on its sign-in screen, with exit 126', async () => {
    const { spawned } = await spawnAgy([], { FAKE_AGY_SIGN_IN: '1' });

    expect(spawned.code).toBe(126);
    expect(spawned.stderr).toContain('Authentication required. Please visit the URL to log in:');
  }, 30_000);

  test('spawn refuses a --model agy does not list, with exit 2, and accepts one it does', async () => {
    const refused = await spawnAgy(['--model', 'no-such-model']);
    expect(refused.spawned.code).toBe(2);
    expect(refused.spawned.stderr).toContain('fake-agy-flash');

    const accepted = await spawnAgy(['--model', 'fake-agy-pro']);
    expect(accepted.spawned.stderr).toBe('');
    expect(accepted.spawned.code).toBe(0);
  }, 30_000);
});
