import { describe as bunDescribe } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { killSession } from '../../src/adapters/tmux.ts';

// ---------------------------------------------------------------------------
// Provider-aware gating
// ---------------------------------------------------------------------------

export type Provider = 'claude' | 'codex' | 'gemini' | 'opencode';

const PROVIDER_BINS: Record<Provider, string[]> = {
  claude: ['/Users/jahala/.local/bin/claude'],
  codex: ['/Users/jahala/Library/Application Support/com.conductor.app/bin/codex'],
  gemini: [],
  opencode: [],
};

const PROVIDER_WHICH: Record<Provider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
};

export function smokeEnabledFor(provider: Provider): boolean {
  if (process.env.UMBEL_SMOKE !== '1') return false;
  for (const bin of PROVIDER_BINS[provider]) {
    if (existsSync(bin)) return true;
  }
  if (Bun.which(PROVIDER_WHICH[provider]) !== null) return true;
  return false;
}

function skipReasonFor(provider: Provider): string {
  if (process.env.UMBEL_SMOKE !== '1') return 'UMBEL_SMOKE != 1';
  return `${provider} binary not found`;
}

export function smokeDescribeFor(provider: Provider, name: string, body: () => void): void {
  if (smokeEnabledFor(provider)) {
    bunDescribe(name, body);
  } else {
    const reason = skipReasonFor(provider);
    bunDescribe.skip(`[smoke] skipped (${reason}): ${name}`, body);
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible wrappers (claude defaults)
// ---------------------------------------------------------------------------

export function smokeEnabled(): boolean {
  return smokeEnabledFor('claude');
}

export function smokeDescribe(name: string, body: () => void): void {
  smokeDescribeFor('claude', name, body);
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
