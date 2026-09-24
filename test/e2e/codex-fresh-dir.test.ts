import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A codex worker spawns in a directory codex has never seen (jahala/umbel#112).
// Every pleach worktree is one. codex 0.154.0 opens there on its update dialog
// and then its trust dialog, whose second option quits with status 0. The skipped
// update dialog stays in tmux scrollback, so a startup loop that matched dialogs
// against scrollback answered the trust dialog with the update dialog's Down and
// quit codex. The cwd is left unresolved (tmpdir is a symlink on macOS), so the
// trust override has to name the real path to be honoured.

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_CODEX = join(import.meta.dir, '..', 'fixtures', 'fake-codex.sh');
const RUN_ID = randomBytes(4).toString('hex');
const DOWN = '\u001b[B';

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

const CREATED: { name: string; env: Record<string, string> }[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((w) => runCli(['kill', w.name], w.env)));
});

async function spawnFresh(fakeEnv: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'umbel-codex-fresh-'));
  const state = join(root, 'state');
  const cwd = join(root, 'cwd');
  const userCodex = join(root, 'codex-home');
  await Promise.all([mkdir(state), mkdir(cwd), mkdir(userCodex)]);
  await writeFile(join(userCodex, 'auth.json'), '{"OPENAI_API_KEY":"fake"}');
  await writeFile(join(userCodex, 'config.toml'), 'model = "fake-model"\n');
  const name = `cf${RUN_ID}${CREATED.length}`;
  const stdinLog = join(root, 'stdin.log');
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
    FAKE_CODEX_STARTUP: '0154-fresh',
    ...fakeEnv,
  };
  const envFlags = Object.entries(workerEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const spawned = await runCli(
    ['spawn', '--name', name, '--cwd', cwd, '--provider', 'codex', '--unattended', ...envFlags],
    env,
  );
  CREATED.push({ name, env });
  const typed = (await readFile(stdinLog, 'utf8').catch(() => '')).split('\n').slice(0, -1);
  return { name, env, spawned, typed };
}

describe('umbel spawn --provider codex in a directory codex has never seen', () => {
  test('trusts the directory at launch, skips the update, and types nothing at the ready screen', async () => {
    const w = await spawnFresh();

    expect(w.spawned.stderr).toBe('');
    expect(w.spawned.code).toBe(0);
    expect(w.typed).toEqual([DOWN]);

    const sent = await runCli(['send', '--json', w.name, 'go'], w.env);
    expect(sent.code).toBe(0);
    const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };
    const waited = await runCli(
      ['wait', '--json', '--since', String(sinceMtime), '--timeout', '20s', w.name],
      w.env,
    );
    expect((JSON.parse(waited.stdout.trim()) as { reason: string }).reason).toBe('stop');
  }, 60_000);

  test('answers the trust dialog with Enter when codex ignores the override, the update dialog still in scrollback', async () => {
    const w = await spawnFresh({ FAKE_CODEX_REFUSE_TRUST: '1' });

    expect(w.spawned.stderr).toBe('');
    expect(w.spawned.code).toBe(0);
    expect(w.typed).toEqual([DOWN, '']);
  }, 60_000);
});

describe('umbel spawn with a --cwd that does not exist', () => {
  test('exits 2 naming the directory, where it used to start the worker somewhere else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'umbel-no-cwd-'));
    const missing = join(root, 'gone');
    const env = { UMBEL_STATE: join(root, 'state'), UMBEL_CLAUDE_BIN: FAKE_CODEX };

    const spawned = await runCli(
      ['spawn', '--name', `nc${RUN_ID}`, '--cwd', missing, '--provider', 'codex'],
      env,
    );

    expect(spawned.code).toBe(2);
    expect(spawned.stderr).toContain(missing);
    expect((await runCli(['ls', '--json'], env)).stdout).not.toContain(`nc${RUN_ID}`);
  }, 30_000);
});
