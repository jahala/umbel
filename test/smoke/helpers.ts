import { describe as bunDescribe } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { killSession } from '../../src/adapters/tmux.ts';

// ---------------------------------------------------------------------------
// smokeEnabled
// ---------------------------------------------------------------------------

const CLAUDE_BIN = '/Users/jahala/.local/bin/claude';

export function smokeEnabled(): boolean {
  if (process.env.RCTRL_SMOKE !== '1') return false;
  if (existsSync(CLAUDE_BIN)) return true;
  if (Bun.which('claude') !== null) return true;
  return false;
}

// ---------------------------------------------------------------------------
// smokeDescribe
// ---------------------------------------------------------------------------

function skipReason(): string {
  if (process.env.RCTRL_SMOKE !== '1') return 'RCTRL_SMOKE != 1';
  return 'claude binary not found';
}

export function smokeDescribe(name: string, body: () => void): void {
  if (smokeEnabled()) {
    bunDescribe(name, body);
  } else {
    const reason = skipReason();
    bunDescribe.skip(`[smoke] skipped (${reason}): ${name}`, body);
  }
}

// ---------------------------------------------------------------------------
// smokeName
// ---------------------------------------------------------------------------

export function smokeName(purpose: string): string {
  const suffix = randomBytes(3).toString('hex');
  return `smk-${purpose}-${suffix}`;
}

// ---------------------------------------------------------------------------
// CleanupGuard
// ---------------------------------------------------------------------------

export interface CleanupGuard {
  register(name: string): void;
  cleanup(): Promise<void>;
}

export function makeCleanupGuard(): CleanupGuard {
  const names: string[] = [];
  return {
    register(name: string): void {
      names.push(name);
    },
    async cleanup(): Promise<void> {
      await Promise.all(names.splice(0).map((n) => killSession(n).catch(() => undefined)));
    },
  };
}

// ---------------------------------------------------------------------------
// runCli — subprocess helper shared by all smoke files
// ---------------------------------------------------------------------------

const MAIN = new URL('../../src/main.ts', import.meta.url).pathname;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(args: string[], stdinText?: string): Promise<RunResult> {
  const proc = Bun.spawn(['bun', 'run', MAIN, ...args], {
    stdin: stdinText !== undefined ? new TextEncoder().encode(stdinText) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code: code ?? 1, stdout, stderr };
}
