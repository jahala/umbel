/**
 * The post-mortem a dead worker leaves, read the way a caller reads it
 * (jahala/umbel#73): through the CLI, one verb per subprocess, nothing shared
 * in memory between the death and the questions asked about it.
 *
 * The worker completes a turn — so the hook records the transcript path and the
 * log — and then dies with status 3 partway through the next. `wait --json`
 * settles that as data: exit 125, the reason, the exit status, a message naming
 * it, and the pane's final screen. `capture`, `logs` and `read` keep answering
 * afterwards. `kill` leaves the directory with `events/dead`, `kill --purge`
 * takes it away, and `prune` sweeps what a plain `kill` left.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';

const FAKE_CLAUDE = join(import.meta.dir, '..', 'fixtures', 'fake-claude.sh');
const MAIN = join(import.meta.dir, '../../src/main.ts');

// Far enough into the turn that `wait`'s alive-pane sample (refreshed every 2s)
// is stale by the time the worker dies, so a snapshot holding the dying line
// can only have come from the dead pane.
const DIE_MS = 3000;
// The substring that tells the fake which turn is its last.
const DIE_PROMPT = 'die';

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
const CREATED: string[] = [];

afterEach(async () => {
  const env = { UMBEL_STATE: tmpDir };
  await Promise.all(CREATED.splice(0).map((n) => killSession(n, env).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

function sessionName(suffix: string): string {
  return `d${RUN_ID}${suffix}`;
}

// The fake's configuration rides in the CLI's environment and reaches the worker
// by name, since a worker inherits no FAKE_* variable on its own (umbel#93).
const passFake = (env: Record<string, string>): string[] =>
  Object.keys(env)
    .filter((k) => k.startsWith('FAKE_'))
    .flatMap((k) => ['--env', k]);

async function setup(fake: Record<string, string> = {}): Promise<Record<string, string>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-dead-worker-'));
  return {
    UMBEL_STATE: tmpDir,
    UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects'),
    FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    ...fake,
  };
}

function sessionDir(name: string): string {
  return join(tmpDir, 'sessions', name);
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

interface DeadEvent {
  at: number;
  by?: string;
  exitCode?: number;
  paneSnapshot?: string;
}

describe('a dead worker answers for itself through the CLI', () => {
  test('wait --json reports the death; capture, logs and read keep answering', async () => {
    const env = await setup({
      FAKE_CLAUDE_DIE_MS: String(DIE_MS),
      FAKE_CLAUDE_DIE_ON: DIE_PROMPT,
      FAKE_CLAUDE_EXIT_CODE: '3',
    });
    const name = sessionName('ev');
    CREATED.push(name);

    const spawned = await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env);
    expect(spawned.code).toBe(0);

    // One turn completed, so the hook has written the transcript path and the
    // log that the post-mortem reads back.
    const alive = await turn(name, 'hello', env);
    expect(alive.code).toBe(0);
    expect(JSON.parse(alive.stdout)).toMatchObject({ reason: 'stop' });

    // The turn it dies in. No hook fires; the pane is the only witness.
    const dead = await turn(name, `now ${DIE_PROMPT}`, env);
    expect(dead.code).toBe(125);
    const payload = JSON.parse(dead.stdout) as {
      reason: string;
      exitCode?: number;
      message?: string;
      paneSnapshot?: string;
    };
    expect(payload.reason).toBe('dead');
    expect(payload.exitCode).toBe(3);
    expect(payload.message).toMatch(/\b3\b/);
    // The screen at the moment of death, not the sample taken while it ran.
    expect(typeof payload.paneSnapshot).toBe('string');
    expect(payload.paneSnapshot ?? '').toContain('dying now');

    // The three questions a post-mortem asks next, all still answered.
    const captured = await runCli(['capture', name], env);
    expect(captured.code).toBe(0);
    expect(captured.stdout).toContain('dying now');

    const logs = await runCli(['logs', name], env);
    expect(logs.code).toBe(0);
    expect(logs.stdout.trim()).not.toBe('');

    const read = await runCli(['read', name], env);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('Response to: hello');
  }, 120_000);

  test('kill leaves the tombstone, --purge removes it', async () => {
    const env = await setup({
      FAKE_CLAUDE_DIE_MS: String(DIE_MS),
      FAKE_CLAUDE_DIE_ON: DIE_PROMPT,
      FAKE_CLAUDE_EXIT_CODE: '3',
    });
    const name = sessionName('tb');
    CREATED.push(name);

    expect(
      (await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env)).code,
    ).toBe(0);
    expect((await turn(name, 'hello', env)).code).toBe(0);
    expect((await turn(name, `now ${DIE_PROMPT}`, env)).code).toBe(125);

    const killed = await runCli(['kill', name], env);
    expect(killed.code).toBe(0);

    // The directory is the record: it stays, and it says how the worker went.
    expect(existsSync(sessionDir(name))).toBe(true);
    const event = JSON.parse(
      await readFile(join(sessionDir(name), 'events', 'dead'), 'utf8'),
    ) as DeadEvent;
    expect(event.exitCode).toBe(3);
    expect(event.paneSnapshot).toContain('dying now');

    // The pane is gone with the session, so the record stands in for it.
    const captured = await runCli(['capture', name], env);
    expect(captured.code).toBe(0);
    expect(captured.stdout).toContain('dying now');

    // Still readable out of the kept directory.
    const read = await runCli(['read', name], env);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('Response to: hello');

    const purged = await runCli(['kill', name, '--purge'], env);
    expect(purged.code).toBe(0);
    expect(existsSync(sessionDir(name))).toBe(false);
    expect((await runCli(['ls'], env)).stdout).not.toContain(name);

    CREATED.splice(CREATED.indexOf(name), 1);
  }, 120_000);

  test('prune sweeps what a plain kill left behind', async () => {
    const env = await setup();
    const name = sessionName('pr');
    CREATED.push(name);

    expect(
      (await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env)).code,
    ).toBe(0);
    expect((await runCli(['kill', name], env)).code).toBe(0);
    expect(existsSync(sessionDir(name))).toBe(true);

    const pruned = await runCli(['prune'], env);
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain(`removed ${name}`);
    expect(pruned.stdout).toContain('1 removed');
    expect(existsSync(sessionDir(name))).toBe(false);

    CREATED.splice(CREATED.indexOf(name), 1);
  }, 120_000);
});
