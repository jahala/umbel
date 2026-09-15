import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionDeadError } from '../core/errors.ts';
import { isInputPending } from '../core/pending-input.ts';
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

  if (provider.pendingInputMatch !== undefined) {
    await confirmSubmitted(d, opts.name, provider.pendingInputMatch, env);
  }

  return { sinceMtime };
}

// ---------------------------------------------------------------------------
// confirmSubmitted — the submitting Enter can be swallowed, leaving the prompt
// in the input box and no turn running. Re-press Enter while it stays pending.
// ---------------------------------------------------------------------------

const SUBMIT_POLL_MS = 300;
const SUBMIT_GRACE_MS = 1500;
// Bounded: an Enter landing on an idle input line is harmless, but pressing
// forever into a TUI that will never take the prompt is not.
const MAX_EXTRA_ENTERS = 3;

async function confirmSubmitted(
  d: Pick<Deps, 'tmux'>,
  name: string,
  pendingInputMatch: RegExp,
  env: Record<string, string | undefined>,
): Promise<void> {
  for (let extraEnters = 0; ; extraEnters++) {
    if (!(await stillPendingAfterGrace(d, name, pendingInputMatch, env))) return;
    if (extraEnters >= MAX_EXTRA_ENTERS) return;
    await d.tmux.sendKeys(name, ['Enter'], env);
  }
}

async function stillPendingAfterGrace(
  d: Pick<Deps, 'tmux'>,
  name: string,
  pendingInputMatch: RegExp,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const deadline = Date.now() + SUBMIT_GRACE_MS;
  for (;;) {
    await Bun.sleep(SUBMIT_POLL_MS);
    const pane = await d.tmux.capturePane(name, 40, env);
    if (!isInputPending(pane, pendingInputMatch)) return false;
    if (Date.now() >= deadline) return true;
  }
}
