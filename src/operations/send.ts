import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SendNotSubmittedError, SessionDeadError } from '../core/errors.ts';
import { pendingInputLine } from '../core/pending-input.ts';
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

  // Verify the worker is alive. Its pane answers that, not its session: with
  // remain-on-exit the session outlives the worker, so a send to a corpse would
  // otherwise be accepted and silently go nowhere.
  const pane = await d.tmux.paneState(opts.name, env);
  if (!pane.exists) {
    throw new SessionDeadError(opts.name, 'tmux session not found');
  }
  if (pane.dead) {
    throw new SessionDeadError(
      opts.name,
      pane.exitCode !== undefined
        ? `worker exited with status ${pane.exitCode}`
        : 'worker exited without a status (killed by a signal)',
    );
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
// in the input box and no turn running. Re-press Enter while it stays pending;
// once the bound is spent, fail rather than report a turn that never began.
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
    const pending = await pendingAfterGrace(d, name, pendingInputMatch, env);
    if (pending === undefined) return;
    if (extraEnters >= MAX_EXTRA_ENTERS) {
      throw new SendNotSubmittedError(name, pending.pane, 1 + extraEnters, pending.line);
    }
    await d.tmux.sendKeys(name, ['Enter'], env);
  }
}

async function pendingAfterGrace(
  d: Pick<Deps, 'tmux'>,
  name: string,
  pendingInputMatch: RegExp,
  env: Record<string, string | undefined>,
): Promise<{ pane: string; line: string } | undefined> {
  const deadline = Date.now() + SUBMIT_GRACE_MS;
  for (;;) {
    await Bun.sleep(SUBMIT_POLL_MS);
    const pane = await d.tmux.capturePane(name, 40, env);
    const line = pendingInputLine(pane, pendingInputMatch);
    if (line === undefined) return undefined;
    if (Date.now() >= deadline) return { pane, line };
  }
}
