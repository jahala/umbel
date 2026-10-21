import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyNotification, type NeedsInputReason } from '../core/notification.ts';
import { PROVIDERS } from '../core/providers/registry.ts';
import { parseQuota, type Quota } from '../core/quota.ts';
import type { Session } from '../core/types.ts';
import { readDeathCause } from './death-record.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// StatusEntry / StatusOpts
// ---------------------------------------------------------------------------

export interface StatusEntry extends Session {
  alive: boolean;
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
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// ---------------------------------------------------------------------------
// Internal: enrich a session with alive + lastActivityAt
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
): Promise<StatusEntry> {
  const eventsDir = d.fs.eventsDir(session.name, env);
  const [pane, dead, logMtime, notifMtime, stopMtime] = await Promise.all([
    d.tmux.paneState(session.name, env),
    d.fs.readDead(session.name, env),
    fileMtime(join(eventsDir, 'log')),
    fileMtime(join(eventsDir, 'notification')),
    fileMtime(join(eventsDir, 'stop')),
  ]);

  // Alive is the pane, not the session: remain-on-exit keeps a dead worker's
  // session standing, and has-session would call that running.
  const entry: StatusEntry = { ...session, alive: pane.exists && !pane.dead, needsInput: false };
  if (logMtime > 0) {
    entry.lastActivityAt = logMtime;
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

  if (entry.alive) {
    const awaiting = await awaitingProviderSince(session, d, env);
    if (awaiting !== undefined) entry.awaitingProviderSince = awaiting;
  }

  return entry;
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
// simply has no request in flight.
async function transcriptPath(
  session: Session,
  d: Deps,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (session.jsonlPath !== null && session.jsonlPath !== '') return session.jsonlPath;
  const hooked = (
    await readFileSafe(join(d.fs.eventsDir(session.name, env), 'transcript-path'))
  ).trim();
  if (hooked !== '') return hooked;
  try {
    return await d.jsonl.discoverSessionJsonl({
      sessionName: session.name,
      cwd: session.cwd,
      sinceMs: session.createdAt,
      timeoutMs: 0,
    });
  } catch {
    return undefined;
  }
}

// A model request in flight is a worker with nothing to write until the answer
// arrives, however long that takes (umbel#117). One field, absent when nothing
// is in flight: a caller can tell a slow provider from a wedged worker without
// a wait of its own.
async function awaitingProviderSince(
  session: Session,
  d: Deps,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const provider = PROVIDERS[session.provider];
  if (provider?.requestInFlight === undefined) return undefined;
  const path = await transcriptPath(session, d, env);
  if (path === undefined) return undefined;
  const content = await readFileSafe(path);
  return provider.requestInFlight(content);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function status(opts: StatusOpts): Promise<StatusEntry[]> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  if (opts.name !== undefined) {
    const session = await d.fs.readMeta(opts.name, env);
    const entry = await enrich(session, d, env);
    return [entry];
  }

  const names = await d.fs.listSessionNames(env);
  const entries: StatusEntry[] = [];

  for (const name of names) {
    try {
      const session = await d.fs.readMeta(name, env);
      const entry = await enrich(session, d, env);
      entries.push(entry);
    } catch {
      // Skip sessions whose meta cannot be read
    }
  }

  // Sort by createdAt ascending
  entries.sort((a, b) => a.createdAt - b.createdAt);
  return entries;
}
