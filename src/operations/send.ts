import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionDeadError } from '../core/errors.ts';
import { getProvider } from '../core/providers/registry.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// SendOpts / SendResult
// ---------------------------------------------------------------------------

export interface SendOpts {
  name: string;
  prompt: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

export interface SendResult {
  sinceMtime: number;
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

export async function send(opts: SendOpts): Promise<SendResult> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  // Verify session meta exists (throws SessionNotFoundError if not) and learn
  // the provider so we can apply its submit-timing quirk.
  const meta = await d.fs.readMeta(opts.name, env);
  const provider = getProvider(meta.provider);

  // Verify tmux session is alive
  const alive = await d.tmux.hasSession(opts.name, env);
  if (!alive) {
    throw new SessionDeadError(opts.name, 'tmux session not found');
  }

  // Snapshot mtime of events/stop before send (0 if absent)
  const stopPath = join(d.fs.eventsDir(opts.name, env), 'stop');
  let sinceMtime = 0;
  try {
    const s = await stat(stopPath);
    sinceMtime = s.mtimeMs;
  } catch {
    // File absent — sinceMtime stays 0
  }

  await d.tmux.sendText(
    opts.name,
    opts.prompt,
    provider.submitDelayMs !== undefined ? { submitDelayMs: provider.submitDelayMs } : undefined,
    env,
  );

  return { sinceMtime };
}
