import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwd } from '../../src/adapters/jsonl.ts';

// ---------------------------------------------------------------------------
// umbel#75 through the CLI a conductor calls: a claude worker that hits its
// account's usage limit shows the dialog and fires its Notification hook. The
// wait ends `input` (exit 126) and its message is the dialog's own line, so the
// caller can read the reset time and schedule a resume.
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FIXTURES = join(import.meta.dir, '..', 'fixtures');
const LIMIT_PANE = join(FIXTURES, 'limit', 'claude-session-limit.txt');
const HIT = "You've hit your session limit · resets 4:30pm (Europe/Copenhagen)";
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

async function spawnClaudeAtLimit(): Promise<{ name: string; env: Record<string, string> }> {
  // HOME points into the tmp dir so claude transcript discovery never reads or
  // writes the real ~/.claude.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'umbel-wait-limit-')));
  const state = join(root, 'state');
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  await Promise.all([mkdir(state), mkdir(home), mkdir(cwd)]);
  const name = `l${RUN_ID}limit`;
  const env: Record<string, string> = {
    UMBEL_STATE: state,
    HOME: home,
    UMBEL_CLAUDE_BIN: join(FIXTURES, 'fake-claude.sh'),
  };
  const workerEnv: Record<string, string> = {
    FAKE_CLAUDE_JSONL_DIR: join(home, '.claude', 'projects', encodeCwd(cwd)),
    FAKE_CLAUDE_HOOK: join(state, 'hooks', 'stop.sh'),
    FAKE_CLAUDE_NOTIFY_HOOK: join(state, 'hooks', 'notify.sh'),
    FAKE_CLAUDE_LIMIT_FILE: LIMIT_PANE,
    // The dialog appears after the send has returned, so the wait is already
    // watching when the Notification hook fires.
    FAKE_CLAUDE_LIMIT_MS: '1500',
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
  };
  return { name, env };
}

describe('umbel wait --json on a worker at its usage limit', () => {
  test('exits 126 with input and the dialog line in message', async () => {
    const { name, env } = await spawnClaudeAtLimit();

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
    expect(result.message).toBe(HIT);
    expect(result.paneSnapshot ?? '').toContain(HIT);
  }, 40_000);
});
