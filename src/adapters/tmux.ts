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

// The tmux client's environment. The server a client starts keeps that
// client's environment as its global environment and hands it to every pane,
// so a client given the caller's whole environment would pass the caller's
// keys to every later worker and hold them in the server for its lifetime
// (umbel#93). tmux itself needs only these: where it runs, its socket dir,
// locale (tmux decides UTF-8 from it) and the terminal for attach.
const CLIENT_ENV_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'TMPDIR',
  'TMUX_TMPDIR',
  'TERM',
  'COLORTERM',
];

export function tmuxClientEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (CLIENT_ENV_NAMES.includes(k) || k.startsWith('LC_'))) out[k] = v;
  }
  return out;
}

// A tmux command answers in milliseconds. Past this it is not slow, it is not
// answering, and every deadline umbel keeps is evaluated between such calls
// (umbel#98). The client is ended and the caller told, rather than held.
export const TMUX_CALL_TIMEOUT_MS = 5_000;

// Every tmux client umbel starts runs through here, bounded. The bound is on
// the wait, not only on the process: a client that is killed can leave a child
// holding the pipe, and reading to its end would hold the caller anyway.
async function runTmux(
  args: string[],
  env: Record<string, string | undefined>,
  input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // stdin is 'ignore' unless the command reads data from it, so the tmux client
  // never consumes our parent's stdin. Bun.spawn otherwise inherits it, and a
  // tmux client that briefly reads on startup can pull a byte from the test
  // runner's stdin that was meant for the agent inside the new session.
  const proc = Bun.spawn(['tmux', ...tmuxArgs(args, env)], {
    stdin: input !== undefined ? new TextEncoder().encode(input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: tmuxClientEnv(),
  });
  const answered = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), TMUX_CALL_TIMEOUT_MS);
  });
  try {
    const settled = await Promise.race([answered, bound]);
    if (settled === undefined) {
      proc.kill('SIGKILL');
      throw new TmuxError(
        args[0] ?? 'tmux',
        `tmux did not answer within ${TMUX_CALL_TIMEOUT_MS / 1000}s`,
      );
    }
    const [stdout, stderr, exitCode] = settled;
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

async function tmux(
  args: string[],
  env: Record<string, string | undefined> = {},
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr, exitCode } = await runTmux(args, env, input);
  if (exitCode !== 0) {
    throw new TmuxError(args[0] ?? 'tmux', stderr.trim());
  }
  return { stdout, stderr };
}

// tmux names the target it could not resolve, and the name depends on the
// command: kill-session says session, list-panes says window even when asked
// for a session. A socket with no server behind it — or none at all, before the
// first worker of a state root — reports connecting rather than finding. All of
// them mean the same thing here: the worker is not there.
const NO_TARGET_RE =
  /can't find session|can't find window|no current session|session not found|no server running|error connecting to/i;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface SpawnSessionOpts {
  name: string;
  cwd: string;
  cmd: string[];
  // The worker's environment, as the launch wrapper reads it, handed over in a
  // named tmux buffer. Absent for a session that runs no launch wrapper.
  envBuffer?: { name: string; content: string };
}

// ---------------------------------------------------------------------------
// newSession
// ---------------------------------------------------------------------------

export async function newSession(
  opts: SpawnSessionOpts,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const target = prefixed(opts.name);
  // The environment goes in by stdin to a buffer the pane's launch wrapper reads
  // and deletes, never as `-e K=V`: those flags sit on the client's argv, and on
  // the server's for its whole life when this client starts it (umbel#93). The
  // buffer is loaded in this invocation, ahead of new-session, so it is there
  // before the pane runs even when this client is the one starting the server.
  //
  // remain-on-exit keeps the pane after the worker's process exits, so its last
  // screen and its exit status survive the death (jahala/umbel#73).
  //
  // Set in the SAME tmux invocation as new-session, and BEFORE it: a second
  // invocation loses the race against a worker that dies at once — the pane is
  // reaped, and with it the session, before the option lands. Ahead of the
  // command rather than chained after it because a `;` argument is what
  // separates tmux commands, so a worker whose argv contained one would have
  // the rest of it parsed as tmux commands. Server-global, which on umbel's
  // private socket means every worker and nothing else.
  const handover =
    opts.envBuffer === undefined ? [] : ['load-buffer', '-b', opts.envBuffer.name, '-', ';'];
  await tmux(
    [
      ...handover,
      'set-option',
      '-g',
      'remain-on-exit',
      'on',
      ';',
      'new-session',
      '-d',
      '-s',
      target,
      '-c',
      opts.cwd,
      '--',
      ...opts.cmd,
    ],
    env,
    opts.envBuffer?.content,
  );
}

// Best-effort removal of a buffer newSession loaded, for a spawn that unwinds
// before its worker could read and delete it.
export async function deleteBuffer(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  await tmux(['delete-buffer', '-b', name], env).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// hasSession
// ---------------------------------------------------------------------------

export async function hasSession(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<boolean> {
  // A tmux that never answers says nothing about the session, so runTmux throws
  // rather than let `false` report a live worker as gone (umbel#98).
  const { exitCode } = await runTmux(['has-session', '-t', prefixed(name)], env);
  return exitCode === 0;
}

// ---------------------------------------------------------------------------
// paneState — liveness, from the worker's pane rather than its session
// ---------------------------------------------------------------------------
//
// With remain-on-exit the session outlives the worker, so `has-session` reports
// a corpse as alive. The pane knows better: `#{pane_dead}` is 1 once the process
// has exited and `#{pane_dead_status}` holds the status it exited with. A pane
// killed by a signal is dead with no status at all — `#{pane_dead_signal}` names
// the signal instead — so exitCode is optional and never parsed from nothing.
//
// Read through list-panes, not display-message: display-message answers for an
// unknown target with an empty string and exit 0 (tmux 3.6), which would report
// a session that never existed as alive.

export interface PaneState {
  exists: boolean;
  dead: boolean;
  exitCode?: number;
  // The signal that killed the process, as tmux names it ('term', 'kill').
  signal?: string;
}

export async function paneState(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<PaneState> {
  let stdout: string;
  try {
    const result = await tmux(
      [
        'list-panes',
        '-s',
        '-t',
        prefixed(name),
        '-F',
        '#{pane_dead} #{pane_dead_status} #{pane_dead_signal}',
      ],
      env,
    );
    stdout = result.stdout;
  } catch (err) {
    if (err instanceof TmuxError && NO_TARGET_RE.test(err.stderr)) {
      return { exists: false, dead: false };
    }
    throw err;
  }

  // The worker is the session's first pane — `-s` lists every window's panes in
  // order, where without it tmux answers for the CURRENT window only. A worker
  // has tmux in its own environment and can open a window of its own; that
  // window's live pane would otherwise report the dead worker as running.
  const [deadFlag = '', status = '', signal = ''] = (stdout.split('\n')[0] ?? '').split(' ');
  const dead = deadFlag === '1';
  const exitCode = Number.parseInt(status, 10);
  return {
    exists: true,
    dead,
    ...(dead && Number.isInteger(exitCode) ? { exitCode } : {}),
    ...(dead && signal !== '' ? { signal } : {}),
  };
}

// ---------------------------------------------------------------------------
// killSession — idempotent (swallows "no such session" errors)
// ---------------------------------------------------------------------------

export async function killSession(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  try {
    await tmux(['kill-session', '-t', prefixed(name)], env);
  } catch (err) {
    if (err instanceof TmuxError && NO_TARGET_RE.test(err.stderr)) return;
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
    const { stderr: loadStderr, exitCode: loadCode } = await runTmux(
      ['load-buffer', '-b', bufName, '-'],
      env,
      text,
    );
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
