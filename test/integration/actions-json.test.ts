/**
 * `rctrl actions --json` — machine-readable ActionManifest egress.
 *
 * The text digest is for LLM orchestrators; --json is for code callers (the
 * pleach conductor assembles WorkerResult.filesTouched from it). Drives the
 * real CLI as a subprocess with the fake-claude fixture.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_CLAUDE = join(import.meta.dir, '../fixtures/fake-claude.sh');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawnCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
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

describe('actions --json', () => {
  test('emits the ActionManifest as a single JSON object on stdout', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-aj-'));
    const name = `aj${randomBytes(4).toString('hex')}`;
    const encodedCwd = tmpDir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonlDir = join(homedir(), '.claude', 'projects', encodedCwd);
    await mkdir(jsonlDir, { recursive: true });

    const baseEnv = {
      RCTRL_STATE: tmpDir,
      RCTRL_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    };

    const spawnR = await spawnCli(['spawn', '--name', name, '--cwd', tmpDir], baseEnv);
    expect(spawnR.code).toBe(0);

    try {
      const sendR = await spawnCli(['send', '--json', name, 'manifest please'], baseEnv);
      expect(sendR.code).toBe(0);
      const since = (JSON.parse(sendR.stdout.trim()) as { sinceMtime: number }).sinceMtime;
      const waitR = await spawnCli(
        ['wait', '--json', '--since', String(since), '--timeout', '15s', name],
        baseEnv,
      );
      expect((JSON.parse(waitR.stdout.trim()) as { reason: string }).reason).toBe('stop');

      const r = await spawnCli(['actions', '--json', name], baseEnv);
      expect(r.code).toBe(0);
      const m = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
      expect(typeof m.toolsUsed).toBe('object');
      expect(Array.isArray(m.filesRead)).toBe(true);
      expect(Array.isArray(m.filesEdited)).toBe(true);
      expect(Array.isArray(m.filesWritten)).toBe(true);
      expect(Array.isArray(m.bashCommands)).toBe(true);
      expect(Array.isArray(m.errors)).toBe(true);
      expect(String(m.finalMessage)).toContain('manifest please');
      expect(m.turnCount).toBe(1);
      // stdout is ONLY the JSON object
      expect(r.stdout.trim()).toBe(JSON.stringify(m));
    } finally {
      await spawnCli(['kill', name], baseEnv).catch(() => undefined);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  test('missing session exits non-zero (no JSON error envelope)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-aj2-'));
    try {
      const r = await spawnCli(['actions', '--json', 'noexist-aj'], { RCTRL_STATE: tmpDir });
      expect(r.code).not.toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
