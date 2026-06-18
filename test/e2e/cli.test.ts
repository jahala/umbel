import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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

    const r = await runCli(['-p', 'hi', '--cwd', tmpDir], {
      ...env,
      UMBEL_STATE: tmpDir,
      UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    });

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
    const spawnResult = await runCli(['spawn', '--name', name, '--cwd', tmpDir], baseEnv);
    expect(spawnResult.code).toBe(0);
    expect(spawnResult.stdout).toContain(name);

    // ls — session should appear
    const lsResult = await runCli(['ls'], baseEnv);
    expect(lsResult.code).toBe(0);
    expect(lsResult.stdout).toContain(name);

    // kill
    const killResult = await runCli(['kill', name], baseEnv);
    expect(killResult.code).toBe(0);

    // ls again — session should be gone
    const lsResult2 = await runCli(['ls'], baseEnv);
    expect(lsResult2.code).toBe(0);
    expect(lsResult2.stdout).not.toContain(name);

    // Remove from CREATED since we already killed it
    const idx = CREATED.indexOf(name);
    if (idx !== -1) CREATED.splice(idx, 1);
  });
});
