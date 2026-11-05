import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';
import { kill } from './kill.ts';
import {
  checkSelection,
  resolveWantedRepo,
  type Selection,
  type SessionCandidate,
  selectSessions,
} from './select.ts';

// ---------------------------------------------------------------------------
// PruneOpts / PruneResult
// ---------------------------------------------------------------------------

export interface PruneOpts extends Selection {
  // Grace period: a session that died more recently than this is left alone,
  // so a sweep on a timer cannot race the post-mortem it is meant to outlive.
  // Omitted, every dead session goes.
  olderThanMs?: number;
  // Report what the sweep would take and remove nothing.
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

export interface PruneResult {
  // Names, in the order they were taken (with --dry-run, the targets).
  removed: string[];
  // Matched dead sessions the grace period spared.
  kept: string[];
  // Matched sessions left alone because their worker is still running.
  live: string[];
  // Named sessions umbel holds no record of.
  notFound: string[];
}

// ---------------------------------------------------------------------------
// prune — the sweep for what `kill` and `remain-on-exit` leave behind
// ---------------------------------------------------------------------------

// A tombstone is small but a machine that spawns workers all day keeps making
// them, and each dead worker also leaves a tmux session standing (the pane is
// held open on purpose, so its last screen survives the death). `prune` clears
// both, for dead sessions only: liveness is read from the pane, because
// `has-session` calls a corpse running.
//
// The selectors are kill's (umbel#170): an overnight build leaves hundreds of
// tombstones, and the run that made them is the only part a conductor may
// sweep. A plain prune still sweeps every dead session.
export async function prune(opts: PruneOpts): Promise<PruneResult> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};
  const cutoff = opts.olderThanMs === undefined ? undefined : Date.now() - opts.olderThanMs;
  const dryRun = opts.dryRun === true;
  const selecting =
    opts.prefix !== undefined || opts.repo !== undefined || (opts.names?.length ?? 0) > 0;
  if (selecting) checkSelection('prune', opts);

  // The candidates come from the state directory, not from `status`: a selector
  // here has to reach dead sessions, and status omits them unless it enriches
  // every one, which costs a pane read and a git call per tombstone. A session
  // is selected by the name and repository its record holds.
  const candidates = await recordedSessions(d, env);
  const wantedRepo = opts.repo === undefined ? undefined : await resolveWantedRepo(opts.repo, d);
  const targets = selecting
    ? selectSessions(opts, candidates, wantedRepo)
    : candidates.map((candidate) => candidate.name);
  const recorded = new Set(candidates.map((candidate) => candidate.name));

  const removed: string[] = [];
  const kept: string[] = [];
  const live: string[] = [];
  const notFound: string[] = [];

  for (const name of targets) {
    // A name prune has no record of is a miss: there is no directory to sweep,
    // and a bare tmux session is not a tombstone.
    if (!recorded.has(name)) {
      notFound.push(name);
      continue;
    }
    const pane = await d.tmux.paneState(name, env);
    if (pane.exists && !pane.dead) {
      // Never swept. Reported only when asked for by a selector or a name; a
      // plain sweep passes over the fleet without a line per live worker.
      if (selecting) live.push(name);
      continue;
    }
    if (cutoff !== undefined && (await diedAt(d, name, env)) > cutoff) {
      kept.push(name);
      continue;
    }
    if (!dryRun) {
      // Purging kill rather than a bare rmSession: the tmux remains, the files
      // the provider wrote into the worker's cwd and the directory all go from
      // one place, and it is idempotent for a session that is already gone.
      await kill({
        name,
        purge: true,
        env,
        ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
      });
    }
    removed.push(name);
  }

  return { removed, kept, live, notFound };
}

// Every session umbel has a state directory for: the candidates a selector
// picks from, dead ones included, which are the sweep's targets.
async function recordedSessions(
  d: Deps,
  env: Record<string, string | undefined>,
): Promise<SessionCandidate[]> {
  const candidates: SessionCandidate[] = [];
  for (const name of await d.fs.listSessionNames(env)) {
    let repo: string | null = null;
    try {
      repo = (await d.fs.readMeta(name, env)).repo;
    } catch {
      // A meta that cannot be read records no repository. The session is still
      // a candidate, and a selector that names no repo can still take it.
    }
    candidates.push({ name, repo });
  }
  return candidates;
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
