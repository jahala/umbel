import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';

const FAKE_CLAUDE = join(import.meta.dir, '..', 'fixtures', 'fake-claude.sh');

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
let projectsDir = '';

async function setup(): Promise<Record<string, string>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-cli-test-'));
  projectsDir = join(tmpDir, 'projects');
  return { UMBEL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
    projectsDir = '';
  }
});

// ---------------------------------------------------------------------------
// CLI subprocess helper
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
): Promise<RunResult> {
  const proc = Bun.spawn(['bun', 'run', MAIN, ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : 'ignore',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cli', () => {
  test('--help exits 0 with usage text', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('umbel');
    expect(r.stdout).toContain('spawn');
  });

  test('-h exits 0 with usage text', async () => {
    const r = await runCli(['-h']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('umbel');
  });

  test('--version exits 0', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/umbel \d/);
  });

  test('unknown verb exits 2', async () => {
    const r = await runCli(['bogus-verb']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown verb');
  });

  test('bare invocation exits 2 and shows help', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('umbel');
  });

  // actions/diff are real verbs (route to their operations), NOT unknown.
  // Missing <name> is a usage error (exit 2 with a verb-specific message),
  // distinct from the "unknown verb" path.
  test('actions is a known verb (requires <name>, not "unknown verb")', async () => {
    const r = await runCli(['actions']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('actions: <name> is required');
    expect(r.stderr).not.toContain('unknown verb');
  });

  test('diff is a known verb (requires <name>, not "unknown verb")', async () => {
    const r = await runCli(['diff']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('diff: <name> is required');
    expect(r.stderr).not.toContain('unknown verb');
  });

  test('--help lists the actions and diff verbs', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('actions');
    expect(r.stdout).toContain('diff');
  });

  test('-p "hi" with fake-claude outputs response and exits 0', async () => {
    const env = await setup();
    const encodedCwd = realpathSync(tmpDir).replace(/[^a-zA-Z0-9]/g, '-');
    const jsonlDir = join(projectsDir, encodedCwd);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(jsonlDir, { recursive: true });

    const r = await runCli(
      ['-p', 'hi', '--cwd', tmpDir, '--env', 'FAKE_CLAUDE_JSONL_DIR', '--env', 'FAKE_CLAUDE_HOOK'],
      {
        ...env,
        UMBEL_STATE: tmpDir,
        UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
        FAKE_CLAUDE_JSONL_DIR: jsonlDir,
        FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
      },
    );

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Response to: hi');
  }, 30_000);

  test('spawn + ls + kill lifecycle', async () => {
    const env = await setup();
    const name = sessionName('lc');
    CREATED.push(name);

    // discoverSessionJsonl looks in ~/.claude/projects/<encodedCwd>/ by default.
    // Point FAKE_CLAUDE_JSONL_DIR to that same path so fake-claude writes there.
    const { homedir } = await import('node:os');
    const encodedCwd = tmpDir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonlDir = join(homedir(), '.claude', 'projects', encodedCwd);

    const baseEnv = {
      ...env,
      UMBEL_CLAUDE_BIN: join(import.meta.dir, '../fixtures/fake-claude.sh'),
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    };

    // spawn
    const spawnResult = await runCli(
      [
        'spawn',
        '--name',
        name,
        '--cwd',
        tmpDir,
        '--env',
        'FAKE_CLAUDE_JSONL_DIR',
        '--env',
        'FAKE_CLAUDE_HOOK',
      ],
      baseEnv,
    );
    expect(spawnResult.code).toBe(0);
    expect(spawnResult.stdout).toContain(name);

    // ls — session should appear
    const lsResult = await runCli(['ls'], baseEnv);
    expect(lsResult.code).toBe(0);
    expect(lsResult.stdout).toContain(name);

    // kill — the tmux session goes, the directory stays as a tombstone
    const killResult = await runCli(['kill', name], baseEnv);
    expect(killResult.code).toBe(0);

    // ls again — a tombstone is not live, so it is left out by default...
    const lsResult2 = await runCli(['ls'], baseEnv);
    expect(lsResult2.code).toBe(0);
    expect(lsResult2.stdout).not.toContain(name);

    // ...and named with --all, where its status says it is dead
    const lsAllResult = await runCli(['ls', '--all'], baseEnv);
    expect(lsAllResult.code).toBe(0);
    expect(lsAllResult.stdout).toContain(name);
    expect(lsAllResult.stdout).toContain('dead');

    // purge — now there is nothing left to list
    const purgeResult = await runCli(['kill', name, '--purge'], baseEnv);
    expect(purgeResult.code).toBe(0);

    const lsResult3 = await runCli(['ls'], baseEnv);
    expect(lsResult3.code).toBe(0);
    expect(lsResult3.stdout).not.toContain(name);

    // Remove from CREATED since we already killed it
    const idx = CREATED.indexOf(name);
    if (idx !== -1) CREATED.splice(idx, 1);
  });

  // A spawned worker, with the fake claude on PATH-by-env. The two FAKE_* names
  // travel through --env, as the worker inherits only what the caller names.
  function fakeClaudeEnv(env: Record<string, string>): Record<string, string> {
    return {
      ...env,
      UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'jsonl'),
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    };
  }

  function spawnArgs(name: string, extra: string[] = []): string[] {
    return [
      'spawn',
      '--name',
      name,
      '--cwd',
      tmpDir,
      '--env',
      'FAKE_CLAUDE_JSONL_DIR',
      '--env',
      'FAKE_CLAUDE_HOOK',
      ...extra,
    ];
  }

  // CREATED was printed as UTC with no zone, so a reader could not tell it from
  // their own clock (umbel#69). The table is read by a person: local time and
  // its offset. JSON keeps the epoch, so a machine never has to parse a zone.
  test('ls prints CREATED in local time with its offset', async () => {
    const env = await setup();
    const name = sessionName('tz');
    CREATED.push(name);
    // UTC+5, so a UTC stamp and a local one differ by five hours on the clock.
    const baseEnv = fakeClaudeEnv({ ...env, TZ: 'Etc/GMT-5' });

    const spawned = await runCli(spawnArgs(name), baseEnv);
    expect(spawned.code).toBe(0);

    const json = await runCli(['ls', '--json'], baseEnv);
    expect(json.code).toBe(0);
    const entries = JSON.parse(json.stdout) as Array<{ name: string; createdAt: number }>;
    const createdAt = entries.find((e) => e.name === name)?.createdAt;
    expect(createdAt).toBeNumber();

    // The same instant, written as a person in UTC+5 reads it.
    const shifted = new Date((createdAt ?? 0) + 5 * 3600_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const table = await runCli(['ls'], baseEnv);
    const row = table.stdout.split('\n').find((line) => line.includes(name));
    expect(row).toContain(`${shifted} +0500`);
  }, 60_000);

  // MODEL was the spawn's --model and nothing else, so every worker that took
  // its provider's default showed `—`, which reads as a failed spawn
  // (umbel#69). The spawn's flag wins; otherwise the table shows the model the
  // provider reports for itself.
  test('ls shows the spawn --model, else the model the provider reports', async () => {
    const env = await setup();
    const explicit = sessionName('mdlx');
    const reported = sessionName('mdlr');
    CREATED.push(explicit, reported);
    const baseEnv = fakeClaudeEnv(env);

    expect((await runCli(spawnArgs(explicit, ['--model', 'sonnet']), baseEnv)).code).toBe(0);
    const named = await runCli(['ls'], baseEnv);
    const namedRow = named.stdout.split('\n').find((line) => line.includes(explicit));
    expect(namedRow).toContain('sonnet');

    expect((await runCli(spawnArgs(reported), baseEnv)).code).toBe(0);
    // What claude's statusline writes on every launch: the model, no limits.
    const eventsDir = join(tmpDir, 'sessions', reported, 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, 'quota'),
      JSON.stringify({ model: { id: 'claude-opus-5-5', display_name: 'Opus' } }),
    );

    const shown = await runCli(['ls'], baseEnv);
    const reportedRow = shown.stdout.split('\n').find((line) => line.includes(reported));
    expect(reportedRow).toContain('claude-opus-5-5');
  }, 60_000);
});
