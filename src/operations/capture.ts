import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// capture — the session's last screen, from the pane or from its record
// ---------------------------------------------------------------------------

export interface CaptureOpts {
  name: string;
  lines?: number;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

export interface CaptureResult {
  text: string;
  // Where the screen came from: the pane still standing, or events/dead —
  // written when the session was torn down. The caller says which, because a
  // record is a moment in the past and a pane is now.
  source: 'pane' | 'dead';
}

// remain-on-exit keeps the pane after the worker's process exits, so a dead
// worker is still read from tmux. Once the session itself is gone — killed, or
// swept — the tombstone is what is left of the last screen. Without a record,
// tmux's own error stands: nothing is invented to fill the gap.
export async function capture(opts: CaptureOpts): Promise<CaptureResult> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  try {
    return { text: await d.tmux.capturePane(opts.name, opts.lines, env), source: 'pane' };
  } catch (err) {
    const dead = await d.fs.readDead(opts.name, env);
    if (dead?.paneSnapshot === undefined || dead.paneSnapshot === '') throw err;
    return { text: dead.paneSnapshot, source: 'dead' };
  }
}
