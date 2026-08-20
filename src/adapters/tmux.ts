import { createHash, randomBytes } from 'node:crypto';
import { TmuxError } from '../core/errors.ts';
import { stateDir } from './fs-state.ts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PREFIX = 'umbel-';

function prefixed(name: string): string {
  return `${PREFIX}${name}`;
}

// Every worker lives on a private tmux socket, never the default one.
//
// The default socket is shared with the user's own sessions and every other
// agent on the machine, so anything that reaps that server — a stray
// `tmux kill-server`, a user tidying up, another agent's cleanup — takes the
// whole fleet with it. Silently: a vanished session leaves no pane and no log,
// and looks exactly like a worker that died on its own.
//
// The name is derived from the state root, so a worker set is visible only to
// umbel invocations sharing that root. That makes isolation structural rather
// than careful — tests run against a temp UMBEL_STATE and therefore cannot see,
// let alone reap, a real worker. UMBEL_TMUX_SOCKET overrides it for callers that
// deliberately want several roots on one socket.
export function socketFor(env: Record<string, string | undefined> = {}): string {
  const override = env.UMBEL_TMUX_SOCKET ?? process.env.UMBEL_TMUX_SOCKET;
  if (override !== undefined && override !== '') return override;
  const digest = createHash('sha256').update(stateDir(env)).digest('hex').slice(0, 12);
  return `umbel-${digest}`;
}

// Every tmux invocation in this file goes through here or carries -L itself.
// A bare `tmux` call would silently land on the default socket and undo the
// isolation above.
function tmuxArgs(args: string[], env: Record<string, string | undefined> = {}): string[] {
  return ['-L', socketFor(env), ...args];
}

async function tmux(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string }> {
  // Explicit 'ignore' for stdin so tmux client never consumes our parent's
  // stdin. Without this, Bun.spawn defaults inherit stdin — and when the
  // tmux client briefly reads on startup, it can pull a byte from the test
  // runner's stdin that was meant for the agent inside the new session.
  const proc = Bun.spawn(['tmux', ...tmuxArgs(args, env)], {
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

export async function newSession(
  opts: SpawnSessionOpts,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const target = prefixed(opts.name);
  const envArgs: string[] = [];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      envArgs.push('-e', `${k}=${v}`);
    }
  }
  await tmux(
    ['new-session', '-d', '-s', target, '-c', opts.cwd, ...envArgs, '--', ...opts.cmd],
    env,
  );
}

// ---------------------------------------------------------------------------
// hasSession
// ---------------------------------------------------------------------------

export async function hasSession(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<boolean> {
  const proc = Bun.spawn(['tmux', ...tmuxArgs(['has-session', '-t', prefixed(name)], env)], {
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

export async function killSession(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  try {
    await tmux(['kill-session', '-t', prefixed(name)], env);
  } catch (err) {
    if (err instanceof TmuxError && NO_SESSION_RE.test(err.stderr)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// listSessions — returns bare names (umbel- prefix stripped)
// ---------------------------------------------------------------------------

export async function listSessions(
  env: Record<string, string | undefined> = {},
): Promise<string[]> {
  let stdout: string;
  try {
    const result = await tmux(['list-sessions', '-F', '#{session_name}'], env);
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

export interface SendTextOpts {
  // Milliseconds to wait between delivering the text and the submitting Enter.
  // Some provider TUIs (Codex) drop an Enter that arrives too soon after a
  // paste. Default 0 (Claude submits fine immediately).
  submitDelayMs?: number;
}

export async function sendText(
  name: string,
  text: string,
  opts?: SendTextOpts,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const target = prefixed(name);
  const useBuffer = text.includes('\n') || text.length > 1000;

  if (useBuffer) {
    const bufName = `umbel-buf-${randomBytes(6).toString('hex')}`;
    // Write text to buffer via stdin (this call MUST pipe stdin)
    const loadProc = Bun.spawn(['tmux', ...tmuxArgs(['load-buffer', '-b', bufName, '-'], env)], {
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
    await tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', target], env);
  } else {
    await tmux(['send-keys', '-t', target, '-l', text], env);
  }
  // Let the TUI ingest the text before the submitting Enter (see SendTextOpts).
  const delay = opts?.submitDelayMs ?? 0;
  if (delay > 0) {
    await Bun.sleep(delay);
  }
  // Send Enter to submit
  await tmux(['send-keys', '-t', target, 'Enter'], env);
}

// ---------------------------------------------------------------------------
// sendKeys — send named tmux keys (Enter, Down, Escape, …) without auto-Enter
// ---------------------------------------------------------------------------
//
// Unlike sendText (which sends literal text + a submitting Enter), this sends
// raw tmux key tokens in order. Used for dismissing startup dialogs where the
// keystroke is a navigation/confirm key, not text. Each token is a tmux
// key-name as understood by `send-keys` (e.g. 'Enter', 'Down', 'Up', 'Escape').

export async function sendKeys(
  name: string,
  keys: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<void> {
  if (keys.length === 0) return;
  const target = prefixed(name);
  await tmux(['send-keys', '-t', target, ...keys], env);
}

// ---------------------------------------------------------------------------
// capturePane — last N lines (default 100)
// ---------------------------------------------------------------------------

export async function capturePane(
  name: string,
  lines = 100,
  env: Record<string, string | undefined> = {},
): Promise<string> {
  const target = prefixed(name);
  const { stdout } = await tmux(['capture-pane', '-p', '-t', target, '-S', `-${lines}`], env);
  return stdout;
}
