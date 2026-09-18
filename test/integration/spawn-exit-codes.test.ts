import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// umbel#110: a spawn that needs a person says so by its exit code. The runner
// contract (jahala/plotplot contracts/runner.md, "A spawn that needs a person
// is blocked, and says so by its exit code") gives the sign-in refusal 126, the
// code and class of the wait reason `input`: a retry meets the same screen.
// Every other spawn failure keeps its code. The umbrella reads the table from
// SPAWN_EXIT_CODES in src/faces/cli.ts.
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_CLAUDE = join(import.meta.dir, '../fixtures/fake-claude.sh');
const LOGIN = join(import.meta.dir, '../fixtures/sign-in/claude-2.1.276-login.txt');
let tmpDir = '';

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

async function spawnCli(args: string[], env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(['bun', 'run', MAIN, 'spawn', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return await proc.exited;
}

describe('umbel spawn exit codes', () => {
  test('a spawn refused at the sign-in screen exits 126', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-spawn-exit-'));
    const code = await spawnCli(
      [
        '--name',
        `t${randomBytes(4).toString('hex')}`,
        '--cwd',
        tmpDir,
        '--env',
        'FAKE_CLAUDE_SIGN_IN',
      ],
      { UMBEL_STATE: tmpDir, UMBEL_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_SIGN_IN: LOGIN },
    );
    expect(code).toBe(126);
  }, 30_000);

  test('an unknown provider still exits 2', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-spawn-exit-'));
    const code = await spawnCli(['--provider', 'nope', '--cwd', tmpDir], { UMBEL_STATE: tmpDir });
    expect(code).toBe(2);
  }, 30_000);

  test('a worker that dies at startup still exits 1', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-spawn-exit-'));
    const code = await spawnCli(
      [
        '--name',
        `t${randomBytes(4).toString('hex')}`,
        '--cwd',
        tmpDir,
        '--env',
        'FAKE_CLAUDE_EXIT_AT_START',
      ],
      { UMBEL_STATE: tmpDir, UMBEL_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_EXIT_AT_START: '3' },
    );
    expect(code).toBe(1);
  }, 30_000);
});
