import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { classifyNotification, type NeedsInputReason } from '../core/notification.ts';
import { type RunningCommand, runningCommands } from '../core/procs.ts';
import { PROVIDERS } from '../core/providers/registry.ts';
import type { AgentProvider } from '../core/providers/types.ts';
import { parseQuota, type Quota } from '../core/quota.ts';
import type { Session } from '../core/types.ts';
import { readDeathCause } from './death-record.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';
import { discoverTranscriptPath } from './resolve-jsonl.ts';

// ---------------------------------------------------------------------------
// StatusEntry / StatusOpts
// ---------------------------------------------------------------------------

// What a worker is doing, in one word, for the table's STATUS column and the
// same field in JSON (umbel#71). `alive` is the honest answer when the provider
// offers no signal that says a turn began, so busy and idle are never guessed.
export type WorkerState = 'busy' | 'idle' | 'input' | 'dead' | 'alive';

export interface StatusEntry extends Session {
  alive: boolean;
  // busy: a turn is open (its start is newer than the last stop); idle: no turn
  // is open; input: the worker is waiting on a person; dead: gone. alive: no
  // turn-start signal, so only liveness can be told.
  state: WorkerState;
  // Newest of the events log (hook fires) and the worker's transcript, so a
  // long turn shows activity while no hook fires (umbel#71).
  lastActivityAt?: number;
  // True when the worker is awaiting the user — the latest notification (newer
  // than the last turn-end) classifies as a real awaiting event, not an
  // informational one (auth_success / elicitation completion).
  needsInput: boolean;
  // Why it's awaiting, when needsInput: permission (blocked on a tool prompt),
  // idle (done + idle), or question (elicitation). Absent when not awaiting.
  needsInputReason?: NeedsInputReason;
  // Best-effort pending tool, when the notification carries one. Absent for
  // Claude's main permission prompt (it omits the tool from the hook payload).
  pendingTool?: string;
  // When the worker has a model request out and unanswered: the request's
  // timestamp. A slow model leaves the pane, the events dir and the transcript
  // still, so this is what tells it from a wedged worker (umbel#117). Absent
  // when nothing is in flight, or when the provider's transcript cannot say.
  awaitingProviderSince?: string;
  // Commands the worker's CLI still has running in its pane — a background
  // command it started and left behind when the turn ended. Empty when none or
  // when the worker is gone. A non-empty list means the turn finished but its
  // work did not (jahala/umbel#106).
  runningCommands: RunningCommand[];
  // Subscription rate-limit usage, when the provider reports any. Absent is the
  // normal case and means no limit pressure was reported — a caller can re-cast
  // a node to another provider before dispatch instead of losing its work to a
  // limit dialog mid-turn.
  quota?: Quota;
  // Set once the worker is gone: what its pane recorded of the death — the
  // status it exited with, absent when a signal killed it — and when that was
  // written down, which only a death someone waited for has. A caller reads the
  // cause without a pane of its own.
  dead?: { exitCode?: number; at?: number };
}

export interface StatusOpts {
  name?: string;
  // Include sessions whose worker is gone. Off by default: a machine that has
  // spawned workers all day holds hundreds of tombstones, and a caller asking
  // "what is running" wants the few live ones (umbel#70). A named session is
  // always answered, dead or not.
  all?: boolean;
  // Only sessions of this repository. A path anywhere inside a repository
  // resolves to that repository's main worktree, so a caller can pass its own
  // worktree and still meet its siblings (umbel#65).
  repo?: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// ---------------------------------------------------------------------------
// Internal: enrich a session with liveness, state and activity
// ---------------------------------------------------------------------------

async function fileMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function enrich(
  session: Session,
  d: Deps,
  env: Record<string, string | undefined>,
  processList: () => Promise<string>,
): Promise<StatusEntry> {
  const eventsDir = d.fs.eventsDir(session.name, env);
  const [pane, dead, logMtime, notifMtime, stopMtime, turnStartMtime] = await Promise.all([
    d.tmux.paneState(session.name, env),
    d.fs.readDead(session.name, env),
    fileMtime(join(eventsDir, 'log')),
    fileMtime(join(eventsDir, 'notification')),
    fileMtime(join(eventsDir, 'stop')),
    session.turnStartEvent === undefined ? 0 : fileMtime(join(eventsDir, session.turnStartEvent)),
  ]);

  // Alive is the pane, not the session: remain-on-exit keeps a dead worker's
  // session standing, and has-session would call that running.
  const entry: StatusEntry = {
    ...session,
    alive: pane.exists && !pane.dead,
    // Replaced below, once the notification has been classified: input outranks
    // whatever the turn signal says.
    state: 'alive',
    needsInput: false,
    runningCommands: [],
  };
  if (pane.pid !== undefined) {
    entry.runningCommands = runningCommands(await processList(), pane.pid);
  }

  // How it went: the record written when the death was found, or — for a worker
  // nobody was waiting on — the launch wrapper's exit record, then the status
  // its pane holds. A tombstone whose remains have been swept answers from the
  // record alone.
  if (dead !== null) {
    entry.dead = {
      at: dead.at,
      ...(dead.exitCode !== undefined ? { exitCode: dead.exitCode } : {}),
    };
  } else if (pane.dead) {
    const { exitCode } = await readDeathCause(d, session.name, pane, env);
    if (exitCode !== undefined) entry.dead = { exitCode };
  }

  // A notification newer than the last turn-end may mean the worker is awaiting
  // input. Classify the latest line to tell permission / idle / question from an
  // informational ping (auth_success, elicitation completion → not awaiting).
  if (notifMtime > 0 && notifMtime > stopMtime) {
    const cls = classifyNotification(await readFileSafe(join(eventsDir, 'notification')));
    if (cls.reason !== null) {
      entry.needsInput = true;
      entry.needsInputReason = cls.reason;
      if (cls.tool !== undefined) entry.pendingTool = cls.tool;
    }
  }

  const quota = parseQuota(await readFileSafe(join(eventsDir, 'quota')));
  if (quota !== null) entry.quota = quota;

  const provider = PROVIDERS[session.provider];
  // The transcript answers LAST and an in-flight request, so its path is
  // resolved once. Only a live worker's transcript is discovered: a listing of
  // tombstones reads paths somebody recorded and never guesses.
  const transcript = await transcriptPath(session, provider, d, env, entry.alive);

  // A hook fires only at a turn's boundaries, so the events log leaves a long
  // turn still; the transcript grows as the worker writes (umbel#71).
  const transcriptMtime = transcript === undefined ? 0 : await fileMtime(transcript);
  const lastActivityAt = Math.max(logMtime, transcriptMtime);
  if (lastActivityAt > 0) entry.lastActivityAt = lastActivityAt;

  // A model request in flight is a worker with nothing to write until the
  // answer arrives, however long that takes (umbel#117). Absent when nothing is
  // in flight: a caller can tell a slow provider from a wedged worker without a
  // wait of its own.
  if (entry.alive && provider?.requestInFlight !== undefined && transcript !== undefined) {
    const awaiting = provider.requestInFlight(await readFileSafe(transcript));
    if (awaiting !== undefined) entry.awaitingProviderSince = awaiting;
  }

  entry.state = workerState(
    entry.alive,
    entry.needsInput,
    session.turnStartEvent !== undefined,
    turnStartMtime,
    stopMtime,
  );
  return entry;
}

// Precedence: a gone worker is dead whatever its files say; a worker waiting on
// a person is input even mid-turn. Only a provider that signals turn starts can
// tell a turn in progress from an idle prompt, so the rest answer `alive`.
// A stop landing in the same millisecond as its turn start wins the tie: the
// turn has ended.
function workerState(
  alive: boolean,
  needsInput: boolean,
  hasTurnSignal: boolean,
  turnStartAt: number,
  stoppedAt: number,
): WorkerState {
  if (!alive) return 'dead';
  if (needsInput) return 'input';
  if (!hasTurnSignal) return 'alive';
  return turnStartAt > stoppedAt ? 'busy' : 'idle';
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

// The transcript status reads is resolved the cheap way: the path meta already
// holds, then the one the stop hook captured, then a single discovery scan. No
// waiting: a status call must answer now, and a session with no transcript yet
// simply has no request in flight. Discovery is for a live worker only, and
// only where a scan can name the worker's own file: codex's rollout search, or
// claude's project directory. Every other provider's transcript is unnamed or
// export-only, and a guess would read another worker's.
async function transcriptPath(
  session: Session,
  provider: AgentProvider | undefined,
  d: Deps,
  env: Record<string, string | undefined>,
  discover: boolean,
): Promise<string | undefined> {
  if (session.jsonlPath !== null && session.jsonlPath !== '') return session.jsonlPath;
  const hooked = (
    await readFileSafe(join(d.fs.eventsDir(session.name, env), 'transcript-path'))
  ).trim();
  if (hooked !== '') return hooked;
  if (!discover || provider === undefined) return undefined;
  if (provider.transcriptSearch === undefined && provider.name !== 'claude') return undefined;
  try {
    return await discoverTranscriptPath({
      name: session.name,
      cwd: session.cwd,
      sinceMs: session.createdAt,
      provider,
      env,
      deps: d,
      timeoutMs: 0,
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function status(opts: StatusOpts): Promise<StatusEntry[]> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  // One process listing per status call, shared by every session: a fleet is
  // asked about together, and one ps per session would be a ps per row.
  let processList: Promise<string> | undefined;
  const processes = (): Promise<string> => (processList ??= d.procs.list());

  if (opts.name !== undefined) {
    const session = await d.fs.readMeta(opts.name, env);
    const entry = await enrich(session, d, env, processes);
    return [entry];
  }

  // Resolved before the loop so a worktree path matches the main worktree the
  // spawn recorded. A path git no longer knows is matched as given, which keeps
  // a session of a deleted repository findable by the path it recorded.
  const wantedRepo =
    opts.repo === undefined ? undefined : ((await d.git.repoRoot(opts.repo)) ?? resolve(opts.repo));

  const names = await d.fs.listSessionNames(env);
  const entries: StatusEntry[] = [];

  for (const name of names) {
    let session: Session;
    try {
      session = await d.fs.readMeta(name, env);
    } catch {
      // Skip sessions whose meta cannot be read
      continue;
    }
    // Before enrich: a session of another repository costs no tmux call.
    if (wantedRepo !== undefined && session.repo !== wantedRepo) continue;
    entries.push(await enrich(session, d, env, processes));
  }

  // Liveness is read per session, so the filter comes after: there is no
  // cheaper proof that a tombstone's worker is gone.
  const listed = opts.all === true ? entries : entries.filter((e) => e.alive);

  // Sort by createdAt ascending
  listed.sort((a, b) => a.createdAt - b.createdAt);
  return listed;
}
