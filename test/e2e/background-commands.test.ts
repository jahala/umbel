import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';

// umbel#106: a worker can end its turn with a command it started still running.
// `wait` at stop and `status --json` both report it, so a caller does not take a
// stop for a quiet worktree. The fake starts the command through `<shell> -c`,
// as Claude Code's Bash tool does, and leaves it running past the stop hook.

const FAKE_CLAUDE = join(import.meta.dir, '..', 'fixtures', 'fake-claude.sh');
const MAIN = join(import.meta.dir, '../../src/main.ts');

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
const CREATED: string[] = [];

interface RunningCommand {
  pid: number;
  command: string;
}

afterEach(async () => {
  const env = { UMBEL_STATE: tmpDir };
  await Promise.all(CREATED.splice(0).map((n) => killSession(n, env).catch(() => undefined)));
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

function sessionName(suffix: string): string {
  return `b${RUN_ID}${suffix}`;
}

// The fake's configuration rides in the CLI's environment and reaches the worker
// by name, since a worker inherits no FAKE_* variable on its own (umbel#93).
const passFake = (env: Record<string, string>): string[] =>
  Object.keys(env)
    .filter((k) => k.startsWith('FAKE_'))
    .flatMap((k) => ['--env', k]);

async function setup(fake: Record<string, string> = {}): Promise<Record<string, string>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-background-'));
  return {
    UMBEL_STATE: tmpDir,
    UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects'),
    FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    ...fake,
  };
}

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

// `send` and `wait` are separate processes, so the stop-mtime baseline has to
// travel between them: send reports it, wait takes it as --since.
async function turn(name: string, prompt: string, env: Record<string, string>): Promise<RunResult> {
  const sent = await runCli(['send', name, prompt, '--json'], env);
  expect(sent.code).toBe(0);
  const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };
  return await runCli(
    ['wait', name, '--json', '--since', String(sinceMtime), '--timeout', '30s'],
    env,
  );
}

async function listedCommands(
  name: string,
  env: Record<string, string>,
): Promise<RunningCommand[]> {
  const result = await runCli(['status', name, '--json'], env);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as Array<{ runningCommands: RunningCommand[] }>;
  return parsed[0]?.runningCommands ?? [];
}

async function until(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`);
}

describe('a stopped worker that left a command running', () => {
  test('wait at stop and status report it; both report none after it ends', async () => {
    const env = await setup({ FAKE_CLAUDE_BACKGROUND_CMD: 'sleep 30' });
    const name = sessionName('bg');
    CREATED.push(name);

    const spawned = await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env);
    expect(spawned.code).toBe(0);

    const stopped = await turn(name, 'start it', env);
    expect(stopped.code).toBe(0);
    const payload = JSON.parse(stopped.stdout) as {
      reason: string;
      runningCommands?: RunningCommand[];
    };
    expect(payload.reason).toBe('stop');
    expect(payload.runningCommands).toHaveLength(1);
    expect(payload.runningCommands?.[0]?.command).toBe('sleep 30');

    // The same answer from a separate `status` process, which reads the pane's
    // live process tree rather than anything the wait kept.
    const listed = await listedCommands(name, env);
    expect(listed).toHaveLength(1);
    const pid = listed[0]?.pid;
    expect(pid).toBeNumber();

    // End the command rather than waiting out its sleep, then poll the status
    // until the pane is quiet. The event is the command's exit, not a delay.
    process.kill(pid as number, 'SIGTERM');
    await until(async () => (await listedCommands(name, env)).length === 0, 10_000);
    expect(await listedCommands(name, env)).toEqual([]);
  }, 120_000);

  test('a worker that left nothing running reports an empty list', async () => {
    const env = await setup();
    const name = sessionName('idle');
    CREATED.push(name);

    const spawned = await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env);
    expect(spawned.code).toBe(0);

    const stopped = await turn(name, 'hello', env);
    expect(stopped.code).toBe(0);
    const payload = JSON.parse(stopped.stdout) as { runningCommands?: RunningCommand[] };
    expect(payload.runningCommands).toEqual([]);
    expect(await listedCommands(name, env)).toEqual([]);
  }, 120_000);
});
