import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';
import { kill } from './kill.ts';

// ---------------------------------------------------------------------------
// PruneOpts / PruneResult
// ---------------------------------------------------------------------------

export interface PruneOpts {
  // Grace period: a session that died more recently than this is left alone,
  // so a sweep on a timer cannot race the post-mortem it is meant to outlive.
  // Omitted, every dead session goes.
  olderThanMs?: number;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

export interface PruneResult {
  // Names, in the order they were swept / passed over.
  removed: string[];
  kept: string[];
}

// ---------------------------------------------------------------------------
// prune — the sweep for what `kill` and `remain-on-exit` leave behind
// ---------------------------------------------------------------------------

// A tombstone is small but a machine that spawns workers all day keeps making
// them, and each dead worker also leaves a tmux session standing (the pane is
// held open on purpose, so its last screen survives the death). `prune` clears
// both, for dead sessions only: liveness is read from the pane, because
// `has-session` calls a corpse running.
export async function prune(opts: PruneOpts): Promise<PruneResult> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};
  const cutoff = opts.olderThanMs === undefined ? undefined : Date.now() - opts.olderThanMs;

  const removed: string[] = [];
  const kept: string[] = [];

  for (const name of await d.fs.listSessionNames(env)) {
    const pane = await d.tmux.paneState(name, env);
    if (pane.exists && !pane.dead) {
      kept.push(name);
      continue;
    }
    if (cutoff !== undefined && (await diedAt(d, name, env)) > cutoff) {
      kept.push(name);
      continue;
    }
    // Purging kill rather than a bare rmSession: the tmux remains, the files
    // the provider wrote into the worker's cwd and the directory all go from
    // one place, and it is idempotent for a session that is already gone.
    await kill({ name, purge: true, env, ...(opts.deps !== undefined ? { deps: opts.deps } : {}) });
    removed.push(name);
  }

  return { removed, kept };
}

// When the death was written down, that moment; otherwise the session's own
// start, which is the only other date umbel has and is always earlier — so a
// grace period never expires before the record it protects is that old.
// A directory whose meta cannot be read holds nothing a post-mortem could use,
// so it is treated as ancient and swept.
async function diedAt(
  d: Deps,
  name: string,
  env: Record<string, string | undefined>,
): Promise<number> {
  const dead = await d.fs.readDead(name, env);
  if (dead !== null) return dead.at;
  try {
    return (await d.fs.readMeta(name, env)).createdAt;
  } catch {
    return 0;
  }
}
