/**
 * status reports the worker's workspace (jahala/umbel#153).
 *
 * A conductor sees whether a worker is alive, but not what it has done to its
 * tree. spawn records the cwd's HEAD, and status reads the worker's cwd against
 * it: the branch and HEAD now, the commits since spawn, and the changed and
 * untracked files plus the diff stat.
 *
 * Every read uses `git --no-optional-locks`, because a plain `git status`
 * refreshes and rewrites `.git/index` when a file's stat info is stale. That
 * takes `.git/index.lock` for a moment, and a worker committing at that instant
 * fails with "index.lock exists". The last two tests hold a real commit open in
 * a temp repository and prove the read never writes the index, so it never
 * takes that lock.
 *
 * Real git runs in a temp repository the test creates and removes. Git writes
 * never happen in the agent's own worktree.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/adapters/exec.ts';
import { workspace } from '../../src/adapters/git.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import type { Session } from '../../src/core/types.ts';
import { runCli } from '../../src/faces/cli.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { status } from '../../src/operations/status.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let root = '';
let state = '';
let repo = '';
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
  }
});

async function tempRoot(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'umbel-workspace-test-'));
  state = join(root, 'state');
}

// A repository with two committed files, so a test can commit one change and
// leave another in the tree.
async function makeRepo(): Promise<void> {
  await tempRoot();
  repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await run(['git', '-C', repo, 'init', '-q']);
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await writeFile(join(repo, 'b.txt'), 'base\n');
  await run(['git', '-C', repo, 'add', '.']);
  await commit('init');
}

async function git(...args: string[]): Promise<string> {
  return run(['git', '-C', repo, ...args]);
}

async function commit(message: string): Promise<string> {
  await run(['git', '-C', repo, 'add', '-A']);
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
    '-m',
    message,
  ]);
  return (await git('rev-parse', 'HEAD')).trim();
}

function spawnEnv(): Record<string, string | undefined> {
  return {
    UMBEL_STATE: state,
    FAKE_CLAUDE_JSONL_DIR: join(state, 'projects'),
    FAKE_CLAUDE_HOOK: join(state, 'hooks', 'stop.sh'),
  };
}

function sessionName(suffix: string): string {
  return `w${RUN_ID}${suffix}`;
}

async function spawnIn(cwd: string, name?: string): Promise<Session> {
  const { session } = await spawn({
    cwd,
    ...(name !== undefined ? { name } : {}),
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: spawnEnv(),
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
// spawn records the base
// ---------------------------------------------------------------------------

describe('spawn records the head the workspace is measured from', () => {
  test('the cwd HEAD; null off git and in a repository with no commit', async () => {
    await makeRepo();
    const base = (await git('rev-parse', 'HEAD')).trim();

    const inRepo = await spawnIn(repo);
    expect(inRepo.baseHead).toBe(base);

    // On disk, where a later status reads it.
    const meta = JSON.parse(
      await readFile(join(state, 'sessions', inRepo.name, 'meta.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(meta.baseHead).toBe(base);

    const plain = join(root, 'plain');
    await mkdir(plain, { recursive: true });
    const offGit = await spawnIn(plain);
    expect(offGit.baseHead).toBeNull();

    // `git init` and nothing else: HEAD is unborn, so there is nothing to
    // measure against yet.
    const bare = join(root, 'unborn');
    await mkdir(bare, { recursive: true });
    await run(['git', '-C', bare, 'init', '-q']);
    const unborn = await spawnIn(bare);
    expect(unborn.baseHead).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// status — the workspace
// ---------------------------------------------------------------------------

describe('status — the workspace', () => {
  test('shows the commit, the uncommitted change and the untracked file', async () => {
    await makeRepo();
    const session = await spawnIn(repo);
    const base = session.baseHead;

    await writeFile(join(repo, 'a.txt'), 'committed\n');
    const head = await commit('worker commit');
    await writeFile(join(repo, 'b.txt'), 'edited\n');
    await writeFile(join(repo, 'c.txt'), 'new\n');

    const [entry] = await status({ name: session.name, env: spawnEnv() });
    const ws = entry?.workspace;
    expect(ws).not.toBeNull();
    if (ws === null || ws === undefined) return;

    expect(ws.branch).toBe((await git('rev-parse', '--abbrev-ref', 'HEAD')).trim());
    expect(ws.head).toBe(head);
    expect(ws.baseHead).toBe(base);
    expect(ws.commits).toEqual([{ hash: head, subject: 'worker commit' }]);
    // The tree right now: b.txt is changed, c.txt is untracked.
    expect(ws.changedFiles).toBe(1);
    expect(ws.untrackedFiles).toBe(1);
    // The work since spawn: a.txt committed and b.txt edited, one line each way.
    expect(ws.diffStat).toEqual({ files: 2, insertions: 2, deletions: 2 });
  }, 60_000);

  test('a worker outside git has no workspace', async () => {
    await tempRoot();
    const plain = join(root, 'plain');
    await mkdir(plain, { recursive: true });
    const session = await spawnIn(plain);

    const [entry] = await status({ name: session.name, env: spawnEnv() });
    expect(entry?.workspace).toBeNull();
  }, 60_000);

  test('a clean tree at the spawn commit has no commits and an empty diff stat', async () => {
    await makeRepo();
    const session = await spawnIn(repo);

    const [entry] = await status({ name: session.name, env: spawnEnv() });
    expect(entry?.workspace?.commits).toEqual([]);
    expect(entry?.workspace?.changedFiles).toBe(0);
    expect(entry?.workspace?.untrackedFiles).toBe(0);
    expect(entry?.workspace?.diffStat).toEqual({ files: 0, insertions: 0, deletions: 0 });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The two faces
// ---------------------------------------------------------------------------

describe('status output', () => {
  test('the table shows a one-line summary and --json carries the fields', async () => {
    await makeRepo();
    const name = sessionName('out');
    const session = await spawnIn(repo, name);

    await writeFile(join(repo, 'a.txt'), 'committed\n');
    await commit('worker commit');
    await writeFile(join(repo, 'c.txt'), 'new\n');

    const human = await cli(['status', name]);
    expect(human.code).toBe(0);
    const row = human.stdout.split('\n').find((line) => line.startsWith(name));
    const summary = row?.split(/\s{2,}/)[4] ?? '';
    expect(summary).toContain((await git('rev-parse', '--abbrev-ref', 'HEAD')).trim());
    expect(summary).toContain('1 commit');
    expect(summary).toContain('1 untracked');
    expect(summary).toContain('+1/-1');

    const json = await cli(['status', name, '--json']);
    const parsed = JSON.parse(json.stdout) as Array<{ workspace: { commits: unknown[] } }>;
    expect(parsed[0]?.workspace.commits).toEqual([
      { hash: (await git('rev-parse', 'HEAD')).trim(), subject: 'worker commit' },
    ]);
    expect(session.baseHead).not.toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The index lock — the reason every read carries --no-optional-locks
// ---------------------------------------------------------------------------

describe('git reads never disturb a commit in the worker tree', () => {
  test('a status call while the worker commits does not make the commit fail', async () => {
    await makeRepo();
    const session = await spawnIn(repo);

    // A slow pre-commit hook holds the commit open, so the status calls land
    // while git is mid-commit.
    await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/usr/bin/env bash\nsleep 1.5\n', {
      mode: 0o755,
    });
    await writeFile(join(repo, 'a.txt'), 'second\n');
    await run(['git', '-C', repo, 'add', 'a.txt']);
    // Fresh stat info would let a plain `git status` skip the index write; make
    // it stale so every read that has optional locks would want to rewrite the
    // index, which is exactly the lock the commit needs.
    await Bun.sleep(1_100);
    await writeFile(join(repo, 'a.txt'), 'second\n');

    const proc = Bun.spawn(
      [
        'git',
        '-C',
        repo,
        '-c',
        'user.email=umbel@example.invalid',
        '-c',
        'user.name=umbel',
        'commit',
        '-q',
        '-m',
        'from worker',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let finished = false;
    const exited = proc.exited.then((code) => {
      finished = true;
      return code;
    });

    let reads = 0;
    while (!finished) {
      await status({ name: session.name, env: spawnEnv() });
      reads += 1;
      await Bun.sleep(20);
    }

    expect(reads).toBeGreaterThan(0);
    expect(await exited).toBe(0);
    expect((await git('log', '-1', '--format=%s')).trim()).toBe('from worker');
  }, 60_000);

  test('a workspace read leaves the index byte for byte; a plain status rewrites it', async () => {
    await makeRepo();
    const base = (await git('rev-parse', 'HEAD')).trim();
    const index = join(repo, '.git', 'index');

    // The control: a touched file makes the index stat info stale, and a plain
    // `git status` refreshes it. This proves the probe is sensitive: if the
    // read wrote the index, the assertion below would see it.
    await Bun.sleep(1_100);
    await writeFile(join(repo, 'a.txt'), 'base\n');
    const beforeControl = await readFile(index);
    await git('status', '--porcelain=v2', '--branch');
    expect((await readFile(index)).equals(beforeControl)).toBe(false);

    await Bun.sleep(1_100);
    await writeFile(join(repo, 'a.txt'), 'base\n');
    const beforeRead = await readFile(index);
    const ws = await workspace(repo, base);
    expect(ws).not.toBeNull();
    expect((await readFile(index)).equals(beforeRead)).toBe(true);
  }, 60_000);
});

// A listing without --all hides dead sessions, so it must not run git in every
// tombstone's cwd to build entries it then drops; a named status or --all still
// reads a dead worker's workspace, which says what it left behind.
describe('status reads a workspace only where it will be shown', () => {
  test('a dead session: not for the live listing, yes for --all and by name', async () => {
    const { ensureSessionDir, writeMeta } = await import('../../src/adapters/fs-state.ts');
    const git = await import('../../src/adapters/git.ts');
    const { SessionSchema } = await import('../../src/core/types.ts');
    const root = await mkdtemp(join(tmpdir(), 'umbel-ws-dead-'));
    try {
      const env = {
        UMBEL_STATE: join(root, 'state'),
        UMBEL_TMUX_SOCKET: `umbel-test-ws-${randomBytes(3).toString('hex')}`,
      };
      const name = 'ws-dead';
      await ensureSessionDir(name, env);
      await writeMeta(
        name,
        SessionSchema.parse({
          name,
          cwd: root,
          anonymous: false,
          createdAt: Date.now(),
          jsonlPath: null,
        }),
        env,
      );
      let reads = 0;
      const deps = {
        git: {
          ...git,
          workspace: async (...args: Parameters<typeof git.workspace>) => {
            reads++;
            return git.workspace(...args);
          },
        },
      };

      await status({ env, deps });
      expect(reads).toBe(0);
      await status({ env, deps, all: true });
      expect(reads).toBe(1);
      await status({ env, deps, name });
      expect(reads).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
