/**
 * jahala/umbel#141 end to end: read can return the old transcript after a
 * worker's /clear.
 *
 * claude's /clear continues the worker in a new session: a new id, a new
 * transcript file, and a Stop hook carrying the new path. A path cached in
 * meta.json by an earlier read must not outrank that newer record. The fake
 * switches transcript file mid-session exactly as the real binary did on
 * 2.1.308: the new session binds through bind.sh rebind, and every later turn
 * lands in the new file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';

const FAKE_CLAUDE = join(import.meta.dir, '..', 'fixtures', 'fake-claude.sh');
const MAIN = join(import.meta.dir, '../../src/main.ts');
const CLEARED_SESSION = 'cleared-session';

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(
    CREATED.splice(0).map((n) => killSession(n, { UMBEL_STATE: tmpDir }).catch(() => undefined)),
  );
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

// A worker inherits no FAKE_* variable on its own (umbel#93), so each rides in
// by name through --env.
const passFake = (env: Record<string, string>): string[] =>
  Object.keys(env)
    .filter((k) => k.startsWith('FAKE_'))
    .flatMap((k) => ['--env', k]);

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

async function setup(): Promise<Record<string, string>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-read-clear-'));
  return {
    UMBEL_STATE: tmpDir,
    UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects'),
    FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    FAKE_CLAUDE_BIND_HOOK: join(tmpDir, 'hooks', 'bind.sh'),
    FAKE_CLAUDE_CLEAR_SESSION_ID: CLEARED_SESSION,
  };
}

async function turn(name: string, prompt: string, env: Record<string, string>): Promise<void> {
  const sent = await runCli(['send', name, prompt, '--json'], env);
  expect(sent.code).toBe(0);
  const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };
  const waited = await runCli(
    ['wait', name, '--json', '--since', String(sinceMtime), '--timeout', '30s'],
    env,
  );
  expect(waited.code).toBe(0);
}

describe('read after a worker /clear', () => {
  test('the transcript the newer Stop hook named wins over the cached one', async () => {
    const env = await setup();
    const name = `c${RUN_ID}`;
    CREATED.push(name);

    const spawned = await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env);
    expect(spawned.code).toBe(0);

    await turn(name, 'first', env);
    const first = await runCli(['read', name], env);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Response to: first');

    // That read cached the first turn's transcript in meta.json, which is what
    // /clear leaves stale.
    const metaPath = join(tmpDir, 'sessions', name, 'meta.json');
    const cached = JSON.parse(await readFile(metaPath, 'utf8')) as { jsonlPath: string };
    expect(cached.jsonlPath).toBe(join(tmpDir, 'projects', `${name}.jsonl`));

    // /clear is a command to the CLI, not a prompt: it begins no turn, so send
    // does not wait for one, and reports success.
    const cleared = await runCli(['send', name, '/clear'], env);
    expect(cleared.stderr).toBe('');
    expect(cleared.code).toBe(0);

    await turn(name, 'second', env);
    const second = await runCli(['read', name], env);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('Response to: second');
    expect(second.stdout).not.toContain('first');

    const refreshed = JSON.parse(await readFile(metaPath, 'utf8')) as { jsonlPath: string };
    expect(refreshed.jsonlPath).toBe(join(tmpDir, 'projects', `${CLEARED_SESSION}.jsonl`));
  }, 120_000);
});
