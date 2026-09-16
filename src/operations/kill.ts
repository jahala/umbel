import { unlink } from 'node:fs/promises';
import type { DeadEvent } from '../core/types.ts';
import { readDeathCause } from './death-record.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

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
