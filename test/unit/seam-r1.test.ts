/**
 * R1 seam-blocker tests — RED suite that drives five deliverables:
 *
 * D1. `rctrl wait --json [--since N]` — JSON stdout, exit 0 regardless of reason
 * D2. `rctrl send --json` — prints {"sinceMtime": N} to stdout
 * D3. MCP sinceMtime wiring — VerbSchemas.wait accepts sinceMtime; mcp handler threads it
 * D4. allowedTools work-or-error — codex/gemini/opencode spawn throws AllowedToolsUnsupportedError
 * D5. Exit-code split — idle returns 123, not 126; HELP lists all codes
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AllowedToolsUnsupportedError } from '../../src/core/errors.ts';
import { VerbSchemas } from '../../src/faces/verbs.ts';

// ---------------------------------------------------------------------------
// D4 — AllowedToolsUnsupportedError class shape
// ---------------------------------------------------------------------------

describe('AllowedToolsUnsupportedError', () => {
  test('is instanceof Error', () => {
    const err = new AllowedToolsUnsupportedError('codex');
    expect(err instanceof Error).toBe(true);
  });

  test('name is AllowedToolsUnsupportedError', () => {
    const err = new AllowedToolsUnsupportedError('codex');
    expect(err.name).toBe('AllowedToolsUnsupportedError');
  });

  test('providerName propagates', () => {
    const err = new AllowedToolsUnsupportedError('gemini');
    expect(err.providerName).toBe('gemini');
  });

  test('message mentions the provider', () => {
    const err = new AllowedToolsUnsupportedError('opencode');
    expect(err.message).toContain('opencode');
  });
});

// ---------------------------------------------------------------------------
// D3 — VerbSchemas.wait accepts sinceMtime
// ---------------------------------------------------------------------------

describe('VerbSchemas.wait — sinceMtime', () => {
  test('parses sinceMtime as optional number', () => {
    const result = VerbSchemas.wait.safeParse({ name: 'foo', sinceMtime: 1234567890 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sinceMtime).toBe(1234567890);
    }
  });

  test('sinceMtime is absent when not provided', () => {
    const result = VerbSchemas.wait.safeParse({ name: 'foo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sinceMtime).toBeUndefined();
    }
  });

  test('rejects non-number sinceMtime', () => {
    const result = VerbSchemas.wait.safeParse({ name: 'foo', sinceMtime: 'abc' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_CLAUDE = join(import.meta.dir, '../fixtures/fake-claude.sh');
const FAKE_CODEX = join(import.meta.dir, '../fixtures/fake-codex.sh');

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

// ---------------------------------------------------------------------------
// D1/D2/D5 — CLI JSON flags and exit-code split (subprocess tests)
// ---------------------------------------------------------------------------

describe('rctrl send --json + wait --json integration', () => {
  test('send --json prints {"sinceMtime": N} and wait --json exits 0 with JSON reason', async () => {
    const tmpDir = await mkdtemp(join(import.meta.dir, '../../.tmp/rctrl-r1-sw-'));
    const name = `r1sw${randomBytes(4).toString('hex')}`;
    const encodedCwd = tmpDir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonlDir = join(homedir(), '.claude', 'projects', encodedCwd);
    await mkdir(jsonlDir, { recursive: true });

    const baseEnv = {
      RCTRL_STATE: tmpDir,
      RCTRL_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    };

    // spawn
    const spawnR = await spawnCli(['spawn', '--name', name, '--cwd', tmpDir], baseEnv);
    expect(spawnR.code).toBe(0);

    try {
      // send --json (--json must come after name+prompt so the parser does not
      // consume 'name' as the flag value, since our argv parser is greedy)
      const sendR = await spawnCli(['send', name, 'hello', '--json'], baseEnv);
      expect(sendR.code).toBe(0);
      // stdout must be ONLY valid JSON with sinceMtime
      const sendJson = JSON.parse(sendR.stdout.trim());
      expect(typeof sendJson.sinceMtime).toBe('number');
      // No extra stdout content
      expect(sendR.stdout.trim()).toBe(JSON.stringify(sendJson));

      // wait --json --since N — should exit 0 regardless of reason
      const waitR = await spawnCli(
        ['wait', '--json', '--since', String(sendJson.sinceMtime), '--timeout', '10s', name],
        baseEnv,
      );
      expect(waitR.code).toBe(0);
      // stdout must be valid JSON with a reason field
      const waitJson = JSON.parse(waitR.stdout.trim());
      expect(typeof waitJson.reason).toBe('string');
      // stderr must be empty (no human-readable output in JSON mode)
      expect(waitR.stderr).toBe('');
    } finally {
      await spawnCli(['kill', name], baseEnv).catch(() => undefined);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 45_000);
});

describe('exit-code split: idle=123, HELP lists exit codes', () => {
  test('HELP text includes exit codes 123, 124, 125, 126', async () => {
    const r = await spawnCli(['--help']);
    expect(r.code).toBe(0);
    // All four non-trivial wait exit codes must appear in HELP
    expect(r.stdout).toContain('123');
    expect(r.stdout).toContain('124');
    expect(r.stdout).toContain('125');
    expect(r.stdout).toContain('126');
    // Should mention 'idle' and 'input' reasons
    expect(r.stdout).toContain('idle');
    expect(r.stdout).toContain('input');
  });
});

describe('D4: allowedTools with unsupported providers exits 2', () => {
  test('spawn codex --allowed-tools exits 2 before side effects', async () => {
    const tmpDir = await mkdtemp(join(import.meta.dir, '../../.tmp/rctrl-r1-at-'));
    try {
      const r = await spawnCli(
        [
          'spawn',
          '--name',
          `r1at${randomBytes(4).toString('hex')}`,
          '--cwd',
          tmpDir,
          '--provider',
          'codex',
          '--allowed-tools',
          'Read,Write',
        ],
        {
          RCTRL_STATE: tmpDir,
          RCTRL_CODEX_BIN: FAKE_CODEX,
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('codex');
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('spawn gemini --allowed-tools exits 2 before side effects', async () => {
    const FAKE_GEMINI = join(import.meta.dir, '../fixtures/fake-gemini.sh');
    const tmpDir = await mkdtemp(join(import.meta.dir, '../../.tmp/rctrl-r1-atg-'));
    try {
      const r = await spawnCli(
        [
          'spawn',
          '--name',
          `r1atg${randomBytes(4).toString('hex')}`,
          '--cwd',
          tmpDir,
          '--provider',
          'gemini',
          '--allowed-tools',
          'Read',
        ],
        {
          RCTRL_STATE: tmpDir,
          RCTRL_GEMINI_BIN: FAKE_GEMINI,
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('gemini');
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('spawn claude --allowed-tools succeeds (still supported)', async () => {
    const tmpDir = await mkdtemp(join(import.meta.dir, '../../.tmp/rctrl-r1-atc-'));
    const encodedCwd = tmpDir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonlDir = join(homedir(), '.claude', 'projects', encodedCwd);
    await mkdir(jsonlDir, { recursive: true });
    const name = `r1atc${randomBytes(4).toString('hex')}`;
    try {
      const r = await spawnCli(
        [
          'spawn',
          '--name',
          name,
          '--cwd',
          tmpDir,
          '--provider',
          'claude',
          '--allowed-tools',
          'Read,Write',
        ],
        {
          RCTRL_STATE: tmpDir,
          RCTRL_CLAUDE_BIN: FAKE_CLAUDE,
          FAKE_CLAUDE_JSONL_DIR: jsonlDir,
          FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
        },
      );
      expect(r.code).toBe(0);
    } finally {
      await spawnCli(['kill', name], { RCTRL_STATE: tmpDir }).catch(() => undefined);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 30_000);
});
