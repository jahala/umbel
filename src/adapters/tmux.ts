import { randomBytes } from 'node:crypto';
import { TmuxError } from '../core/errors.ts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PREFIX = 'rctrl-';

function prefixed(name: string): string {
  return `${PREFIX}${name}`;
}

async function tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // Explicit 'ignore' for stdin so tmux client never consumes our parent's
  // stdin. Without this, Bun.spawn defaults inherit stdin — and when the
  // tmux client briefly reads on startup, it can pull a byte from the test
  // runner's stdin that was meant for the agent inside the new session.
  const proc = Bun.spawn(['tmux', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new TmuxError(args[0] ?? 'tmux', stderr.trim());
  }
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface SpawnSessionOpts {
  name: string;
  cwd: string;
  cmd: string[];
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// newSession
// ---------------------------------------------------------------------------

export async function newSession(opts: SpawnSessionOpts): Promise<void> {
  const target = prefixed(opts.name);
  const envArgs: string[] = [];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      envArgs.push('-e', `${k}=${v}`);
    }
  }
  await tmux(['new-session', '-d', '-s', target, '-c', opts.cwd, ...envArgs, '--', ...opts.cmd]);
}

// ---------------------------------------------------------------------------
// hasSession
// ---------------------------------------------------------------------------

export async function hasSession(name: string): Promise<boolean> {
  const proc = Bun.spawn(['tmux', 'has-session', '-t', prefixed(name)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  return code === 0;
}

// ---------------------------------------------------------------------------
// killSession — idempotent (swallows "no such session" errors)
// ---------------------------------------------------------------------------

const NO_SESSION_RE = /can't find session|no current session|session not found|no server running/i;

export async function killSession(name: string): Promise<void> {
  try {
    await tmux(['kill-session', '-t', prefixed(name)]);
  } catch (err) {
    if (err instanceof TmuxError && NO_SESSION_RE.test(err.stderr)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// listSessions — returns bare names (rctrl- prefix stripped)
// ---------------------------------------------------------------------------

export async function listSessions(): Promise<string[]> {
  let stdout: string;
  try {
    const result = await tmux(['list-sessions', '-F', '#{session_name}']);
    stdout = result.stdout;
  } catch {
    // tmux returns non-zero when there are no sessions at all
    return [];
  }
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(PREFIX))
    .map((s) => s.slice(PREFIX.length));
}

// ---------------------------------------------------------------------------
// sendText — auto-routes based on content
// ---------------------------------------------------------------------------

export async function sendText(name: string, text: string): Promise<void> {
  const target = prefixed(name);
  const useBuffer = text.includes('\n') || text.length > 1000;

  if (useBuffer) {
    const bufName = `rctrl-buf-${randomBytes(6).toString('hex')}`;
    // Write text to buffer via stdin (this call MUST pipe stdin)
    const loadProc = Bun.spawn(['tmux', 'load-buffer', '-b', bufName, '-'], {
      stdin: new TextEncoder().encode(text),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [loadStderr, loadCode] = await Promise.all([
      new Response(loadProc.stderr).text(),
      loadProc.exited,
    ]);
    if (loadCode !== 0) {
      throw new TmuxError('load-buffer', loadStderr.trim());
    }
    // Paste buffer (bracketed paste, delete after)
    await tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', target]);
  } else {
    await tmux(['send-keys', '-t', target, '-l', text]);
  }
  // Send Enter to submit
  await tmux(['send-keys', '-t', target, 'Enter']);
}

// ---------------------------------------------------------------------------
// capturePane — last N lines (default 100)
// ---------------------------------------------------------------------------

export async function capturePane(name: string, lines = 100): Promise<string> {
  const target = prefixed(name);
  const { stdout } = await tmux(['capture-pane', '-p', '-t', target, '-S', `-${lines}`]);
  return stdout;
}
