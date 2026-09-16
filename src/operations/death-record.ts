import type { PaneState } from '../adapters/tmux.ts';
import type { DeathCause } from '../core/death.ts';
import type { Deps } from './deps.ts';

// ---------------------------------------------------------------------------
// readDeathCause — how a worker ended, from umbel's record before tmux's
// ---------------------------------------------------------------------------

// events/exit is written by the launch wrapper as the process ends, on every
// platform. tmux's pane status is the fallback for a worker the wrapper could
// not record (SIGKILL, a launch that predates it): some tmux builds record
// nothing for a dead pane (umbel#91).
export async function readDeathCause(
  d: Pick<Deps, 'fs'>,
  name: string,
  pane: PaneState,
  env: Record<string, string | undefined>,
): Promise<DeathCause> {
  const record = await d.fs.readExit(name, env);
  if (record !== null) return { exists: pane.exists, ...record };
  return pane;
}
