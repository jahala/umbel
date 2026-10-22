import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwd } from '../../src/adapters/jsonl.ts';

// ---------------------------------------------------------------------------
// umbel#129 through the CLI a conductor calls: a claude worker whose provider
// refuses the turn (out of credit) prints the API error and fires only its idle
// notification, with no stop. The wait ends `input` (exit 126) and its message
// is the provider's own error line, so the caller can tell a refused turn from
// a question and recast the work instead of answering.
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FIXTURES = join(import.meta.dir, '..', 'fixtures');
const ERROR_PANE = join(FIXTURES, 'error', 'claude-api-error.txt');
const ERROR_MESSAGE =
  'API Error: 402 Insufficient Balance (request_id: 220c4fea-a416-4840-bfc6-68aa1de49bf3)';
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

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function spawnClaudeAtProviderError(): Promise<{
  name: string;
  env: Record<string, string>;
}> {
  // HOME points into the tmp dir so claude transcript discovery never reads or
  // writes the real ~/.claude.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'umbel-wait-api-error-')));
  const state = join(root, 'state');
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  await Promise.all([mkdir(state), mkdir(home), mkdir(cwd)]);
  const name = `e${RUN_ID}api`;
  const env: Record<string, string> = {
    UMBEL_STATE: state,
    HOME: home,
    UMBEL_CLAUDE_BIN: join(FIXTURES, 'fake-claude.sh'),
  };
  const workerEnv: Record<string, string> = {
    FAKE_CLAUDE_JSONL_DIR: join(home, '.claude', 'projects', encodeCwd(cwd)),
    FAKE_CLAUDE_HOOK: join(state, 'hooks', 'stop.sh'),
    FAKE_CLAUDE_NOTIFY_HOOK: join(state, 'hooks', 'notify.sh'),
    FAKE_CLAUDE_ERROR_FILE: ERROR_PANE,
    FAKE_CLAUDE_ERROR_IDLE: '1',
    // The error and its idle notification land after the send has returned, so
    // the wait is already watching when the hook fires.
    FAKE_CLAUDE_ERROR_MS: '1500',
  };
  const envFlags = Object.entries(workerEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

  const spawned = await runCli(
    ['spawn', '--name', name, '--cwd', cwd, '--provider', 'claude', ...envFlags],
    env,
  );
  expect(spawned.stderr).toBe('');
  expect(spawned.code).toBe(0);

  cleanup = async () => {
    await runCli(['kill', name], env);
    await rm(root, { recursive: true, force: true });
  };
  return { name, env };
}

describe('umbel wait --json on a worker whose provider refused the turn', () => {
  test('exits 126 with input and the error line in message', async () => {
    const { name, env } = await spawnClaudeAtProviderError();

    const sent = await runCli(['send', '--json', name, 'go'], env);
    expect(sent.code).toBe(0);
    const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };

    const waited = await runCli(
      ['wait', '--json', '--since', String(sinceMtime), '--timeout', '20s', name],
      env,
    );

    expect(waited.code).toBe(126);
    const result = JSON.parse(waited.stdout.trim()) as {
      reason: string;
      inputReason?: string;
      message?: string;
      paneSnapshot?: string;
    };
    expect(result.reason).toBe('input');
    expect(result.inputReason).toBe('idle');
    expect(result.message).toBe(ERROR_MESSAGE);
    expect(result.paneSnapshot ?? '').toContain('API Error: 402 Insufficient Balance');
  }, 40_000);
});
