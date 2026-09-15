import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwd } from '../../src/adapters/jsonl.ts';

// A wedged worker is a failure and a busy one is not, and a conductor learns
// which from the CLI alone: exit code and JSON. A provider error on the pane is
// 122 with the error line, every source still is 123 with a message naming the
// sources, and a silent pane over a working subagent is a normal stop.

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FIXTURES = join(import.meta.dir, '..', 'fixtures');
const ROOT = join(import.meta.dir, '..', '..');
const RUN_ID = randomBytes(4).toString('hex');

const CODEX_404 =
  'unexpected status 404 Not Found: The model gpt-5.5 does not exist or you do not have access to it';

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
}

const CREATED: Worker[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((w) => runCli(['kill', w.name], w.env)));
});

// HOME points into the tmp dir so claude transcript discovery, which the CLI
// cannot be handed a projects root for, never reads or writes the real ~/.claude.
async function spawnCli(
  provider: 'claude' | 'codex',
  fakeEnv: Record<string, string>,
): Promise<Worker> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), `umbel-wedged-${provider}-`)));
  const state = join(root, 'state');
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  await Promise.all([mkdir(state), mkdir(home), mkdir(cwd)]);
  const name = `w${RUN_ID}${provider}${CREATED.length}`;
  const env: Record<string, string> = {
    UMBEL_STATE: state,
    HOME: home,
    UMBEL_CLAUDE_BIN: join(FIXTURES, `fake-${provider}.sh`),
  };
  const workerEnv: Record<string, string> = { ...fakeEnv };
  if (provider === 'codex') {
    const userCodex = join(root, 'codex-home');
    await mkdir(userCodex);
    await writeFile(join(userCodex, 'auth.json'), '{"OPENAI_API_KEY":"fake"}');
    await writeFile(join(userCodex, 'config.toml'), 'model = "fake-model"\n');
    env.CODEX_HOME = userCodex;
    workerEnv.FAKE_CODEX_JSONL_DIR = cwd;
    workerEnv.FAKE_CODEX_HOOK = join(state, 'hooks', 'stop.sh');
  } else {
    workerEnv.FAKE_CLAUDE_JSONL_DIR = join(home, '.claude', 'projects', encodeCwd(cwd));
    workerEnv.FAKE_CLAUDE_HOOK = join(state, 'hooks', 'stop.sh');
  }
  const envFlags = Object.entries(workerEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

  const spawned = await runCli(
    ['spawn', '--name', name, '--cwd', cwd, '--provider', provider, ...envFlags],
    env,
  );
  expect(spawned.stderr).toBe('');
  expect(spawned.code).toBe(0);
  const worker = { name, env };
  CREATED.push(worker);
  return worker;
}

async function sendAndWait(w: Worker, idleTimeout: string) {
  const sent = await runCli(['send', '--json', w.name, 'go'], w.env);
  expect(sent.code).toBe(0);
  const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };

  const startedAt = Date.now();
  const waited = await runCli(
    [
      'wait',
      '--json',
      '--since',
      String(sinceMtime),
      '--idle-timeout',
      idleTimeout,
      '--timeout',
      '20s',
      w.name,
    ],
    w.env,
  );
  const lines = waited.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  const json = JSON.parse(lines[0] ?? '') as { reason: string; message?: string };
  return { ...waited, json, elapsedMs: Date.now() - startedAt };
}

describe('umbel wait --json --idle-timeout — wedged vs busy through the CLI', () => {
  test('codex 404 on the pane exits 122 with provider-error and the error line', async () => {
    const w = await spawnCli('codex', { FAKE_CODEX_ERROR: CODEX_404 });

    // A threshold far above the settle time: provider-error must not wait for idle.
    const r = await sendAndWait(w, '60s');

    expect(r.json.reason).toBe('provider-error');
    const message = r.json.message ?? '';
    expect(message).toMatch(/unexpected status 404/);
    // tmux may wrap the line; the message is a trimmed piece of what was printed.
    expect(CODEX_404).toContain(message);
    expect(r.code).toBe(122);
    expect(r.elapsedMs).toBeLessThan(15_000);
  }, 40_000);

  test('a hung worker exits 123 with idle and a message naming the sources', async () => {
    const w = await spawnCli('claude', { FAKE_CLAUDE_HANG_MS: '8000' });

    const r = await sendAndWait(w, '1500ms');

    expect(r.json.reason).toBe('idle');
    const message = r.json.message ?? '';
    expect(message).toMatch(/^idle \d+(?:\.\d+)?s: /);
    for (const source of ['pane', 'events', 'transcript']) {
      expect(message).toMatch(new RegExp(`\\b${source} still \\d+(?:\\.\\d+)?s\\b`));
    }
    expect(message).toMatch(/\bsubagents (none|still \d+(?:\.\d+)?s)\b/);
    expect(r.code).toBe(123);
  }, 40_000);

  test('a silent pane over a working subagent exits 0 with stop', async () => {
    const w = await spawnCli('claude', { FAKE_CLAUDE_SUBAGENT_MS: '4000' });

    const r = await sendAndWait(w, '1500ms');

    expect(r.json.reason).toBe('stop');
    expect(r.code).toBe(0);
  }, 40_000);
});

describe('the exit code 122 and the idle message are documented', () => {
  test('umbel --help lists 122 provider-error', async () => {
    const r = await runCli(['--help'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\s*122\s+wait provider-error\b/m);
  });

  test('docs/cli-reference.md lists 122 in the exit-code table and describes it in wait', async () => {
    const doc = await readFile(join(ROOT, 'docs', 'cli-reference.md'), 'utf8');
    expect(doc).toMatch(/^\| 122 \| `wait` provider-error\b/m);

    const waitStart = doc.indexOf('\n### wait\n');
    expect(waitStart).toBeGreaterThan(-1);
    const waitEnd = doc.indexOf('\n---\n', waitStart);
    const waitSection = doc.slice(waitStart, waitEnd);

    expect(waitSection).toMatch(/^\| provider-error \| 122 \|/m);
    const idleRow = waitSection.split('\n').find((l) => l.startsWith('| idle | 123 |')) ?? '';
    expect(idleRow).toContain('message');

    const idleFlag = waitSection.split('\n').find((l) => l.startsWith('| `--idle-timeout')) ?? '';
    expect(idleFlag).toContain('pane');
    expect(idleFlag).toContain('events directory');
    expect(idleFlag).toContain('transcript tree');

    // The exit code now carries the reason in --json mode too; the docs must not
    // promise the opposite.
    expect(waitSection).not.toMatch(/always 0|exit 0 regardless/i);
  });
});
