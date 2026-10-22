import { unlink } from 'node:fs/promises';
import { UmbelUsageError } from '../core/errors.ts';
import type { DeadEvent } from '../core/types.ts';
import { readDeathCause } from './death-record.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';
import { status } from './status.ts';

// ---------------------------------------------------------------------------
// KillOpts
// ---------------------------------------------------------------------------

export interface KillOpts {
  name: string;
  // Remove the session directory too. Off by default: the callers that kill a
  // worker on failure are the ones that need its record afterwards, so what is
  // left behind is a tombstone. `prune` is the sweep.
  purge?: boolean;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// ---------------------------------------------------------------------------
// kill
// ---------------------------------------------------------------------------

export async function kill(opts: KillOpts): Promise<void> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  // A name with no meta.json is not an umbel session — a bare tmux session
  // that happens to share it. It gets torn down, but no tombstone and no
  // cleanup, because umbel wrote nothing for it.
  let meta: Awaited<ReturnType<typeof d.fs.readMeta>> | undefined;
  try {
    meta = await d.fs.readMeta(opts.name, env);
  } catch {
    // session may already be gone or never persisted
  }

  if (meta !== undefined) await recordDeath(d, opts.name, env);

  await d.tmux.killSession(opts.name, env);

  // Provider-written files live in the project cwd, not in the session
  // directory, so they go whether or not the tombstone stays. Best-effort —
  // a missing file never blocks the kill.
  if (meta !== undefined) {
    for (const filePath of meta.providerFiles) {
      await unlink(filePath).catch(() => undefined);
    }
  }

  if (opts.purge === true) {
    // The launch wrapper writes events/exit as the worker goes down, which is
    // after the session is torn down; removing the directory first would race
    // that write.
    if (meta !== undefined) await awaitExitRecord(d, opts.name, env);
    await d.fs.rmSession(opts.name, env);
  }
}

// ---------------------------------------------------------------------------
// killMany — the same kill, for one or more names or a selector
// ---------------------------------------------------------------------------

export type KillOutcome = 'killed' | 'already-dead' | 'not-found' | 'failed';

export interface KillResult {
  name: string;
  outcome: KillOutcome;
  // Set for 'failed': what stopped the kill.
  error?: string;
}

export interface KillManyOpts {
  // Names kill exactly those sessions, in the order given.
  names?: string[];
  // A selector picks live sessions. With both, a session must match both.
  prefix?: string;
  repo?: string;
  // Report the targets and kill nothing.
  dryRun?: boolean;
  purge?: boolean;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// One failure does not stop the others, so a caller that kills a fleet gets a
// report per session and the face decides the exit code. A selector is answered
// by `status`, the one place liveness and a session's repository are decided;
// every selected session is alive by construction (umbel#94).
export async function killMany(opts: KillManyOpts): Promise<KillResult[]> {
  const env = opts.env ?? {};
  const names = opts.names ?? [];
  const selecting = opts.prefix !== undefined || opts.repo !== undefined;

  if (names.length > 0 && selecting) {
    throw new UmbelUsageError('kill: name the sessions or select them with prefix/repo, not both.');
  }
  if (names.length === 0 && !selecting) {
    throw new UmbelUsageError('kill: give a session name, or select with prefix or repo.');
  }

  const targets =
    names.length > 0
      ? [...new Set(names)]
      : (
          await status({
            env,
            ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
            ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
          })
        )
          .map((entry) => entry.name)
          .filter((name) => opts.prefix === undefined || name.startsWith(opts.prefix));

  const results: KillResult[] = [];
  for (const name of targets) {
    const state = await inspect(name, env, opts.deps);
    if (state.outcome === 'not-found' || opts.dryRun === true) {
      results.push(state);
      continue;
    }
    try {
      await kill({
        name,
        ...(opts.purge !== undefined ? { purge: opts.purge } : {}),
        env,
        ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
      });
      results.push(state);
    } catch (err) {
      results.push({
        name,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// What the kill will find, read before anything is torn down. A live pane is a
// kill, a tombstone or a paneless directory is already dead, and neither means
// the name was never a session. A bare tmux session with no state directory is
// still killable, as it always was.
async function inspect(
  name: string,
  env: Record<string, string | undefined>,
  deps: Partial<Deps> | undefined,
): Promise<KillResult> {
  const d = { ...defaultDeps, ...deps };
  let meta: Awaited<ReturnType<typeof d.fs.readMeta>> | undefined;
  try {
    meta = await d.fs.readMeta(name, env);
  } catch {
    // No state directory: a bare tmux session, or nothing at all.
  }
  const pane = await d.tmux.paneState(name, env);
  if (meta === undefined && !pane.exists) return { name, outcome: 'not-found' };
  return { name, outcome: pane.exists && !pane.dead ? 'killed' : 'already-dead' };
}

// A worker the wrapper cannot record (SIGKILL, launched before the wrapper)
// never writes one, so the wait is bounded.
const EXIT_RECORD_WAIT_MS = 1000;
const EXIT_RECORD_POLL_MS = 25;

async function awaitExitRecord(
  d: Deps,
  name: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const by = Date.now() + EXIT_RECORD_WAIT_MS;
  while ((await d.fs.readExit(name, env).catch(() => null)) === null && Date.now() < by) {
    await Bun.sleep(EXIT_RECORD_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// recordDeath — the last screen, read while there is still a pane to read
// ---------------------------------------------------------------------------

// The record stands in for the pane once the pane is gone, so it holds what
// `capture` would have shown: its default depth.
const TOMBSTONE_PANE_LINES = 100;

// The pane outlives the worker's process but not its session, so the kill is
// the last moment the final screen and the exit status can be had. What `wait`
// already wrote is closer to the death than anything readable now, so it is
// kept and only `by` is added on top. Best-effort throughout: a post-mortem is
// worth having, never worth failing the kill for.
async function recordDeath(
  d: Deps,
  name: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  try {
    const pane = await d.tmux.paneState(name, env);
    if (!pane.exists) return;

    const existing = await d.fs.readDead(name, env);
    let paneSnapshot = existing?.paneSnapshot;
    if (paneSnapshot === undefined || paneSnapshot === '') {
      paneSnapshot = await d.tmux
        .capturePane(name, TOMBSTONE_PANE_LINES, env)
        .catch(() => undefined);
    }
    const exitCode =
      existing?.exitCode ??
      (pane.dead ? (await readDeathCause(d, name, pane, env)).exitCode : undefined);

    const dead: DeadEvent = {
      at: existing?.at ?? Date.now(),
      by: 'kill',
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(paneSnapshot !== undefined && paneSnapshot !== '' ? { paneSnapshot } : {}),
    };
    await d.fs.writeDead(name, dead, env);
  } catch {
    // Nothing left to read, or the state dir is unwritable — the kill stands.
  }
}
