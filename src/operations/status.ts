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
}

export interface StatusOpts {
  name?: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// ---------------------------------------------------------------------------
// Internal: enrich a session with alive + lastActivityAt
// ---------------------------------------------------------------------------

async function enrich(
  session: Session,
  d: Deps,
  env: Record<string, string | undefined>,
): Promise<StatusEntry> {
  const [alive, lastActivityAt] = await Promise.all([
    d.tmux.hasSession(session.name),
    (async () => {
      const logPath = join(d.fs.eventsDir(session.name, env), 'log');
      try {
        const s = await stat(logPath);
        return s.mtimeMs;
      } catch {
        return undefined;
      }
    })(),
  ]);

  const entry: StatusEntry = { ...session, alive };
  if (lastActivityAt !== undefined) {
    entry.lastActivityAt = lastActivityAt;
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
