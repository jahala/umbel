import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider } from '../../src/core/providers/codex.ts';

// The prompt lands, or the send fails (jahala/umbel#77), as a conductor sees it
// through the CLI. codex 0.154.0 keeps building its screen after the banner and
// can raise the trust dialog late, so spawn must return only once that dialog is
// answered and the idle prompt line has settled. A worker that swallows the
// submitting Enter still runs its turn; one that never takes the paste makes
// send exit 1 naming the pending input, rather than a wait that never ends.

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_CODEX = join(import.meta.dir, '..', 'fixtures', 'fake-codex.sh');
const ROOT = join(import.meta.dir, '..', '..');
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
  stdinLog: string;
  spawnedAt: number;
}

const CREATED: Worker[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((w) => runCli(['kill', w.name], w.env)));
});

async function spawnCodex(fakeEnv: Record<string, string>): Promise<Worker> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'umbel-send-confirm-')));
  const state = join(root, 'state');
  const cwd = join(root, 'cwd');
  const userCodex = join(root, 'codex-home');
  await Promise.all([mkdir(state), mkdir(cwd), mkdir(userCodex)]);
  await writeFile(join(userCodex, 'auth.json'), '{"OPENAI_API_KEY":"fake"}');
  await writeFile(join(userCodex, 'config.toml'), 'model = "fake-model"\n');
  const name = `sc${RUN_ID}${CREATED.length}`;
  const stdinLog = join(cwd, 'stdin.log');
  const env: Record<string, string> = {
    UMBEL_STATE: state,
    HOME: join(root, 'home'),
    CODEX_HOME: userCodex,
    UMBEL_CLAUDE_BIN: FAKE_CODEX,
  };
  const workerEnv: Record<string, string> = {
    FAKE_CODEX_JSONL_DIR: cwd,
    FAKE_CODEX_HOOK: join(state, 'hooks', 'stop.sh'),
    FAKE_CODEX_STDIN_LOG: stdinLog,
    ...fakeEnv,
  };
  const envFlags = Object.entries(workerEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

  const spawned = await runCli(
    ['spawn', '--name', name, '--cwd', cwd, '--provider', 'codex', ...envFlags],
    env,
  );
  const spawnedAt = Date.now();
  const worker = { name, env, stdinLog, spawnedAt };
  CREATED.push(worker);
  expect(spawned.stderr).toBe('');
  expect(spawned.code).toBe(0);
  return worker;
}

async function stdinLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').slice(0, -1);
}

async function waitForStop(w: Worker, sinceMtime: number) {
  const waited = await runCli(
    ['wait', '--json', '--since', String(sinceMtime), '--timeout', '20s', w.name],
    w.env,
  );
  const json = JSON.parse(waited.stdout.trim()) as { reason: string };
  return { ...waited, json };
}

const RECORDED_STARTUP = { FAKE_CODEX_STARTUP: '0154' };

describe('umbel spawn/send with codex — the prompt lands, or the send fails', () => {
  test('spawn against the recorded 0.154.0 startup returns after the trust dialog is answered and the prompt line settled', async () => {
    const w = await spawnCodex(RECORDED_STARTUP);

    // The only thing typed into the worker so far is the Enter answering the
    // trust dialog, and spawn returned a full settle window after it.
    expect(await stdinLines(w.stdinLog)).toEqual(['']);
    const answeredAt = (await stat(w.stdinLog)).mtimeMs;
    const settleMs = CodexProvider.readySettleMs ?? 0;
    expect(settleMs).toBeGreaterThan(0);
    expect(w.spawnedAt - answeredAt).toBeGreaterThanOrEqual(settleMs);

    const pane = await runCli(['capture', w.name], w.env);
    expect(pane.code).toBe(0);
    expect(pane.stdout).not.toMatch(/trust the contents of this directory/i);
    expect(pane.stdout).toMatch(/› Ask Codex to do anything/);

    const sent = await runCli(['send', '--json', w.name, 'go'], w.env);
    expect(sent.stderr).toBe('');
    expect(sent.code).toBe(0);
    const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };
    const r = await waitForStop(w, sinceMtime);
    expect(r.json.reason).toBe('stop');
    expect(r.code).toBe(0);
    expect(await stdinLines(w.stdinLog)).toEqual(['', 'go']);
  }, 60_000);

  test('send on a worker that swallows the first Enter exits 0 and wait reaches stop', async () => {
    const w = await spawnCodex({ ...RECORDED_STARTUP, FAKE_CODEX_SWALLOW_ENTERS: '1' });

    const sent = await runCli(['send', '--json', w.name, 'go'], w.env);
    expect(sent.stderr).toBe('');
    expect(sent.code).toBe(0);
    const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };

    const r = await waitForStop(w, sinceMtime);
    expect(r.json.reason).toBe('stop');
    expect(r.code).toBe(0);
  }, 60_000);

  test('send on a worker that never takes the paste exits 1 naming the pending input', async () => {
    const w = await spawnCodex({ ...RECORDED_STARTUP, FAKE_CODEX_SWALLOW_ENTERS: '99' });
    const prompt = 'summarise the repository';

    const sent = await runCli(['send', w.name, prompt], w.env);

    expect(sent.code).toBe(1);
    expect(sent.stdout).toBe('');
    expect(sent.stderr).toContain(w.name);
    expect(sent.stderr).toContain(`[Pasted Content ${prompt.length} chars]`);
  }, 60_000);
});

function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n### ${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const end = doc.indexOf('\n---\n', start);
  return doc.slice(start, end === -1 ? undefined : end);
}

describe('docs/cli-reference.md states readiness and the send confirmation', () => {
  test('the send section states the confirmation, its bound, the failure and its exit code', async () => {
    const doc = await readFile(join(ROOT, 'docs', 'cli-reference.md'), 'utf8');
    const send = section(doc, 'send');

    expect(send).toMatch(/Enter again/i);
    expect(send).toMatch(/at most three times/i);
    expect(send).toContain('[Pasted Content');
    expect(send).toMatch(/exits? 1/);
    expect(send).toContain('pending');
  });

  test('the spawn section states readiness is the idle prompt line plus a settle', async () => {
    const doc = await readFile(join(ROOT, 'docs', 'cli-reference.md'), 'utf8');
    const spawn = section(doc, 'spawn');

    expect(spawn).toMatch(/idle prompt line/i);
    expect(spawn).toMatch(/settle/i);
    expect(spawn).toMatch(/dialog/i);
  });
});
