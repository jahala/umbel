import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyNotification, type NeedsInputReason } from '../core/notification.ts';
import type { Session } from '../core/types.ts';
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
  const [alive, logMtime, notifMtime, stopMtime] = await Promise.all([
    d.tmux.hasSession(session.name, env),
    fileMtime(join(eventsDir, 'log')),
    fileMtime(join(eventsDir, 'notification')),
    fileMtime(join(eventsDir, 'stop')),
  ]);

  const entry: StatusEntry = { ...session, alive, needsInput: false };
  if (logMtime > 0) {
    entry.lastActivityAt = logMtime;
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
  return entry;
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
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
