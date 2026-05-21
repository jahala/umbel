import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// KillOpts
// ---------------------------------------------------------------------------

export interface KillOpts {
  name: string;
  removeState?: boolean;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// ---------------------------------------------------------------------------
// kill
// ---------------------------------------------------------------------------

export async function kill(opts: KillOpts): Promise<void> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};
  const removeState = opts.removeState !== false;

  await d.tmux.killSession(opts.name);

  if (removeState) {
    await d.fs.rmSession(opts.name, env);
  }
}
