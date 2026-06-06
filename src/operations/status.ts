import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from '../core/types.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// StatusEntry / StatusOpts
// ---------------------------------------------------------------------------

export interface StatusEntry extends Session {
  alive: boolean;
  lastActivityAt?: number;
  // True when the worker is BLOCKED waiting on the user: a Notification hook
  // touched events/notification more recently than the turn-ending events/stop.
  needsInput: boolean;
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
    d.tmux.hasSession(session.name),
    fileMtime(join(eventsDir, 'log')),
    fileMtime(join(eventsDir, 'notification')),
    fileMtime(join(eventsDir, 'stop')),
  ]);

  const entry: StatusEntry = {
    ...session,
    alive,
    // Blocked iff a notification arrived more recently than the last turn end.
    needsInput: notifMtime > 0 && notifMtime > stopMtime,
  };
  if (logMtime > 0) {
    entry.lastActivityAt = logMtime;
  }
  return entry;
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
