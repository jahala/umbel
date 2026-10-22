/**
 * A session records the repository it runs in (jahala/umbel#65).
 *
 * A conductor runs many workers, often several worktrees of one repository, and
 * a listing had nothing to say which sessions belonged to whom. Spawn reads the
 * repository once, while the cwd is known, and records it in meta.json; `ls`
 * shows its folder name and `--repo` keeps only one repository.
 *
 * The repository is the top-level of the MAIN working tree, so every linked
 * worktree of one repository records the same path. `git worktree list
 * --porcelain` names it first whatever worktree it runs from; the tests drive
 * real git in a temp repository to hold that.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { run } from '../../src/adapters/exec.ts';
import { repoRoot } from '../../src/adapters/git.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import type { Session } from '../../src/core/types.ts';
import { runCli } from '../../src/faces/cli.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { status } from '../../src/operations/status.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let root = '';
let state = '';
let repo = '';
let worktree = '';
let plain = '';
let restoreState: (() => void) | undefined;
const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  restoreState?.();
  restoreState = undefined;
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = '';
    state = '';
    repo = '';
    worktree = '';
    plain = '';
  }
});

// A repository with one commit, a linked worktree of it, and a directory that
// belongs to no repository.
async function workspace(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'umbel-repo-test-'));
  state = join(root, 'state');
  repo = join(root, 'main-repo');
  worktree = join(root, 'main-repo-wt');
  plain = join(root, 'plain');
  await mkdir(plain, { recursive: true });
  await run(['git', 'init', '-q', repo]);
  await run([
    'git',
    '-C',
    repo,
    '-c',
    'user.email=umbel@example.invalid',
    '-c',
    'user.name=umbel',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ]);
  await run(['git', '-C', repo, 'worktree', 'add', '-q', '--detach', worktree]);
}

function spawnEnv(): Record<string, string | undefined> {
  return {
    UMBEL_STATE: state,
    FAKE_CLAUDE_JSONL_DIR: join(state, 'projects'),
    FAKE_CLAUDE_HOOK: join(state, 'hooks', 'stop.sh'),
  };
}

async function spawnIn(cwd: string, env: Record<string, string | undefined>): Promise<Session> {
  const { session } = await spawn({
    cwd,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env,
  });
  CREATED.push(session.name);
  return session;
}

type WriteType = typeof process.stdout.write;

// The CLI reads its state root from the real environment, so the temp root has
// to be there as well as in the env passed to the operations.
async function cli(argv: string[]): Promise<{ code: number; stdout: string }> {
  const previous = process.env.UMBEL_STATE;
  restoreState = () => {
    if (previous === undefined) delete process.env.UMBEL_STATE;
    else process.env.UMBEL_STATE = previous;
  };
  process.env.UMBEL_STATE = state;

  let stdout = '';
  const origStdout = process.stdout.write.bind(process.stdout) as WriteType;
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  let code = 1;
  try {
    code = await runCli(argv);
  } finally {
    process.stdout.write = origStdout;
  }
  return { code, stdout };
}

// ---------------------------------------------------------------------------
// repoRoot — the adapter that answers the question
// ---------------------------------------------------------------------------

describe('repoRoot', () => {
  test('names the main worktree from the checkout and from a linked worktree', async () => {
    await workspace();
    const main = await realpath(repo);

    expect(await repoRoot(repo)).toBe(main);
    expect(await repoRoot(worktree)).toBe(main);

    // A caller may pass any path in the repository, not only its top.
    await mkdir(join(repo, 'src'));
    expect(await repoRoot(join(repo, 'src'))).toBe(main);
  });

  test('is null outside a git repository', async () => {
    await workspace();
    expect(await repoRoot(plain)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// spawn — the record
// ---------------------------------------------------------------------------

describe('spawn records the repository', () => {
  test('a checkout and a linked worktree record the same main worktree; off git is null', async () => {
    await workspace();
    const env = spawnEnv();
    const main = await realpath(repo);

    const inMain = await spawnIn(repo, env);
    const inWorktree = await spawnIn(worktree, env);
    const offGit = await spawnIn(plain, env);

    expect(inMain.repo).toBe(main);
    expect(inWorktree.repo).toBe(main);
    expect(offGit.repo).toBeNull();

    // And the record survives to disk, where a later listing reads it.
    const [entry] = await status({ name: inWorktree.name, env });
    expect(entry?.repo).toBe(main);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// status — the repo filter
// ---------------------------------------------------------------------------

describe('status — repo filter', () => {
  test('keeps that repository, resolving a worktree path to its main worktree', async () => {
    await workspace();
    const env = spawnEnv();

    const inRepo = await spawnIn(repo, env);
    const offGit = await spawnIn(plain, env);

    const listed = (await status({ env, repo: worktree })).map((e) => e.name);
    expect(listed).toContain(inRepo.name);
    expect(listed).not.toContain(offGit.name);

    // Any path inside the repository asks for the same repository.
    const fromTop = (await status({ env, repo: repo })).map((e) => e.name);
    expect(fromTop).toEqual(listed);
  }, 60_000);

  test('a session from before the field is recorded has no repo', async () => {
    await workspace();
    const env = spawnEnv();
    const session = await spawnIn(repo, env);

    // meta.json as an older umbel wrote it: no repo field at all.
    const metaPath = join(state, 'sessions', session.name, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    delete meta.repo;
    await writeFile(metaPath, JSON.stringify(meta));

    const [entry] = await status({ name: session.name, env });
    expect(entry?.repo).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// ls — the REPO column and --repo
// ---------------------------------------------------------------------------

describe('ls', () => {
  test('shows the repository folder name and filters with --repo', async () => {
    await workspace();
    const env = spawnEnv();
    const inRepo = await spawnIn(repo, env);
    const offGit = await spawnIn(plain, env);

    const filtered = await cli(['ls', '--repo', worktree]);
    expect(filtered.code).toBe(0);
    expect(filtered.stdout).toContain('REPO');
    // The folder name, not the full path, and it appears nowhere else in the row.
    expect(filtered.stdout).toContain(basename(repo));
    expect(filtered.stdout).toContain(inRepo.name);
    expect(filtered.stdout).not.toContain(offGit.name);

    // Outside any repository nothing matches: a session records null there.
    const none = await cli(['ls', '--repo', plain]);
    expect(none.code).toBe(0);
    expect(none.stdout).not.toContain(inRepo.name);
    expect(none.stdout).not.toContain(offGit.name);

    // A bare --repo is refused, not read as "every repository".
    expect((await cli(['ls', '--repo'])).code).toBe(2);
  }, 60_000);

  test('a session with no recorded repository shows a dash', async () => {
    await workspace();
    const env = spawnEnv();
    const session = await spawnIn(repo, env);

    const metaPath = join(state, 'sessions', session.name, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    delete meta.repo;
    await writeFile(metaPath, JSON.stringify(meta));

    const { code, stdout } = await cli(['status', session.name]);
    expect(code).toBe(0);
    const row = stdout.split('\n').find((line) => line.startsWith(session.name));
    // Columns are joined by two spaces; REPO is the fourth.
    expect(row?.split(/\s{2,}/)[3]).toBe('—');
  }, 60_000);
});
