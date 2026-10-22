/**
 * `kill` takes many names and two selectors (jahala/umbel#94).
 *
 * Cleanup used to be a hand-written loop over `umbel ls`:
 *
 *   for s in $(umbel ls | awk '/^pl-/{print $1}'); do umbel kill "$s"; done
 *
 * That loop kills every `pl-` session on the machine, including another
 * conductor's live run, and it parses a table by column so a header change
 * breaks it. So `kill` takes one or more names, or selects live sessions with
 * `--prefix` and `--repo` (a session must match both), reports each session as
 * killed, already dead or not found, and takes `--dry-run` to show the targets.
 * There is deliberately no `--all`.
 *
 * `ls --json` is the loop-free form for anyone who still needs to select: the
 * same array `status --json` prints, honouring `--all` and `--repo`.
 *
 * Driven through the CLI face, because the flags and the per-session report are
 * the contract the conductors read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/adapters/exec.ts';
import { hasSession, killSession } from '../../src/adapters/tmux.ts';
import { runCli } from '../../src/faces/cli.ts';
import { spawn } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(3).toString('hex');

let root = '';
let state = '';
let restoreState: (() => void) | undefined;
const CREATED: string[] = [];
let sequence = 0;

// A fresh state root per test, and the CLI reads it from the real environment:
// getCliEnv forwards only UMBEL_STATE, so both places have to agree.
async function workspace(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'umbel-kill-many-'));
  state = join(root, 'state');
  const previous = process.env.UMBEL_STATE;
  restoreState = () => {
    if (previous === undefined) delete process.env.UMBEL_STATE;
    else process.env.UMBEL_STATE = previous;
  };
  process.env.UMBEL_STATE = state;
}

function env(): Record<string, string | undefined> {
  return {
    UMBEL_STATE: state,
    FAKE_CLAUDE_JSONL_DIR: join(state, 'projects'),
    FAKE_CLAUDE_HOOK: join(state, 'hooks', 'stop.sh'),
  };
}

async function spawnIn(cwd: string, name: string): Promise<string> {
  const { session } = await spawn({
    name,
    cwd,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: env(),
  });
  CREATED.push(session.name);
  return session.name;
}

// `pl-<run id><n>`: a prefix unique to this run, so a selector cannot reach
// another worker on the shared machine even by accident.
function nameOf(base: string): string {
  sequence += 1;
  return `${base}-${RUN_ID}${sequence}`;
}

const PREFIX = `pl-${RUN_ID}`;

async function gitRepo(path: string): Promise<void> {
  await run(['git', 'init', '-q', path]);
  await run([
    'git',
    '-C',
    path,
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
}

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  restoreState?.();
  restoreState = undefined;
  if (root !== '') {
    await rm(root, { recursive: true, force: true });
    root = '';
    state = '';
  }
});

// ---------------------------------------------------------------------------
// CLI capture
// ---------------------------------------------------------------------------

type WriteType = typeof process.stdout.write;

async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const origStdout = process.stdout.write.bind(process.stdout) as WriteType;
  const origStderr = process.stderr.write.bind(process.stderr) as WriteType;
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  let code = 1;
  try {
    code = await runCli(argv);
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// kill — many names
// ---------------------------------------------------------------------------

describe('kill — many names', () => {
  test('one call kills three and reports each', async () => {
    await workspace();
    const names = [
      await spawnIn(root, nameOf('a')),
      await spawnIn(root, nameOf('b')),
      await spawnIn(root, nameOf('c')),
    ];

    const { code, stdout } = await cli(['kill', ...names]);

    expect(code).toBe(0);
    for (const name of names) {
      expect(stdout).toContain(`killed ${name}`);
      expect(await hasSession(name, env())).toBe(false);
    }
  }, 60_000);

  test('an unknown name is reported without stopping the others, and exits non-zero', async () => {
    await workspace();
    const first = await spawnIn(root, nameOf('a'));
    const second = await spawnIn(root, nameOf('b'));
    const ghost = `ghost-${RUN_ID}${sequence}`;

    const { code, stdout } = await cli(['kill', first, ghost, second]);

    expect(code).not.toBe(0);
    expect(stdout).toContain(`killed ${first}`);
    expect(stdout).toContain(`not found ${ghost}`);
    expect(stdout).toContain(`killed ${second}`);
    expect(await hasSession(first, env())).toBe(false);
    expect(await hasSession(second, env())).toBe(false);
  }, 60_000);

  test('a session that is already gone is reported as already dead', async () => {
    await workspace();
    const name = await spawnIn(root, nameOf('gone'));

    expect((await cli(['kill', name])).code).toBe(0);
    const again = await cli(['kill', name]);

    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`already dead ${name}`);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// kill — the --prefix selector (the acceptance case)
// ---------------------------------------------------------------------------

describe('kill — --prefix', () => {
  test('--dry-run lists the matches; the real run kills them and leaves the rest', async () => {
    await workspace();
    const matches = [
      await spawnIn(root, nameOf('pl')),
      await spawnIn(root, nameOf('pl')),
      await spawnIn(root, nameOf('pl')),
    ];
    const probe = await spawnIn(root, nameOf('probe'));

    const dry = await cli(['kill', '--prefix', PREFIX, '--dry-run']);
    expect(dry.code).toBe(0);
    for (const name of matches) {
      expect(dry.stdout).toContain(`would kill ${name}`);
      expect(await hasSession(name, env())).toBe(true);
    }
    expect(dry.stdout).not.toContain(probe);
    expect(await hasSession(probe, env())).toBe(true);

    const real = await cli(['kill', '--prefix', PREFIX]);
    expect(real.code).toBe(0);
    for (const name of matches) {
      expect(real.stdout).toContain(`killed ${name}`);
      expect(await hasSession(name, env())).toBe(false);
    }
    expect(await hasSession(probe, env())).toBe(true);

    // The table and the JSON listing agree: only the probe is left.
    const listed = await cli(['ls']);
    expect(listed.stdout).toContain(probe);
    for (const name of matches) expect(listed.stdout).not.toContain(name);
  }, 60_000);

  test('a selector that matches nothing kills nothing and says so', async () => {
    await workspace();
    const probe = await spawnIn(root, nameOf('probe'));

    const { code, stdout } = await cli(['kill', '--prefix', PREFIX]);

    expect(code).toBe(0);
    expect(stdout).toContain('no live sessions matched');
    expect(await hasSession(probe, env())).toBe(true);
  }, 60_000);

  test('--purge applies to every selected session', async () => {
    await workspace();
    const names = [await spawnIn(root, nameOf('pl')), await spawnIn(root, nameOf('pl'))];

    const { code } = await cli(['kill', '--prefix', PREFIX, '--purge']);

    expect(code).toBe(0);
    for (const name of names) {
      expect(await hasSession(name, env())).toBe(false);
      expect(existsSync(join(state, 'sessions', name))).toBe(false);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// kill — --prefix with --repo
// ---------------------------------------------------------------------------

describe('kill — --prefix with --repo', () => {
  test("kills only that repository's matches", async () => {
    await workspace();
    const repoA = join(root, 'repo-a');
    const repoB = join(root, 'repo-b');
    await gitRepo(repoA);
    await gitRepo(repoB);

    const inA = [await spawnIn(repoA, nameOf('pl')), await spawnIn(repoA, nameOf('pl'))];
    const inB = [await spawnIn(repoB, nameOf('pl')), await spawnIn(repoB, nameOf('pl'))];

    const { code, stdout } = await cli(['kill', '--prefix', PREFIX, '--repo', repoA]);

    expect(code).toBe(0);
    for (const name of inA) {
      expect(stdout).toContain(`killed ${name}`);
      expect(await hasSession(name, env())).toBe(false);
    }
    for (const name of inB) {
      expect(stdout).not.toContain(name);
      expect(await hasSession(name, env())).toBe(true);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// kill — usage
// ---------------------------------------------------------------------------

describe('kill — usage', () => {
  test('names and selectors cannot be mixed', async () => {
    await workspace();

    const { code, stderr } = await cli(['kill', `probe-${RUN_ID}`, '--prefix', PREFIX]);

    expect(code).toBe(2);
    expect(stderr).toContain('kill:');
  });

  test('no names and no selector is a usage error', async () => {
    await workspace();

    const { code, stderr } = await cli(['kill']);

    expect(code).toBe(2);
    expect(stderr).toContain('kill:');
  });
});

// ---------------------------------------------------------------------------
// ls --json — the loop-free listing
// ---------------------------------------------------------------------------

describe('ls --json', () => {
  test('agrees with the table, and --all adds the dead', async () => {
    await workspace();
    const first = await spawnIn(root, nameOf('probe'));
    const second = await spawnIn(root, nameOf('probe'));

    const table = await cli(['ls']);
    expect(table.code).toBe(0);
    const tableNames = table.stdout
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(/\s{2,}/)[0] ?? '')
      .filter((name) => name !== '');

    const live = await cli(['ls', '--json']);
    expect(live.code).toBe(0);
    const liveNames = (JSON.parse(live.stdout) as Array<{ name: string }>).map((e) => e.name);
    expect(liveNames.sort()).toEqual([...tableNames].sort());

    expect((await cli(['kill', first])).code).toBe(0);

    const afterKill = (
      JSON.parse((await cli(['ls', '--json'])).stdout) as Array<{ name: string }>
    ).map((e) => e.name);
    expect(afterKill).not.toContain(first);
    expect(afterKill).toContain(second);

    const every = (
      JSON.parse((await cli(['ls', '--json', '--all'])).stdout) as Array<{
        name: string;
      }>
    ).map((e) => e.name);
    expect(every).toContain(first);
  }, 60_000);
});
