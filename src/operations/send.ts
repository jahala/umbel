import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SendNotSubmittedError,
  SendTurnNotStartedError,
  SessionDeadError,
} from '../core/errors.ts';
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

  // Verify the worker is alive before typing. Its pane answers that, not its
  // session: with remain-on-exit the session outlives the worker, so a send to
  // a corpse would otherwise be accepted and silently go nowhere.
  await assertAlive(d, opts.name, env);

  // Snapshot mtime of events/stop before send (0 if absent)
  const eventsDir = d.fs.eventsDir(opts.name, env);
  const sinceMtime = await mtimeOrZero(join(eventsDir, 'stop'));

  // Snapshot the turn-start signal before typing, so only this prompt's turn
  // can advance it. The signal is the one the worker was launched with.
  const turnStartPath =
    meta.turnStartEvent !== undefined ? join(eventsDir, meta.turnStartEvent) : undefined;
  const sinceTurnStart = turnStartPath !== undefined ? await mtimeOrZero(turnStartPath) : 0;

  await d.tmux.sendText(
    opts.name,
    provider.stream?.encodePrompt(opts.prompt) ?? opts.prompt,
    provider.submitDelayMs !== undefined ? { submitDelayMs: provider.submitDelayMs } : undefined,
    env,
  );

  if (provider.pendingInputMatch !== undefined) {
    await confirmSubmitted(d, opts.name, provider.pendingInputMatch, env);
  }

  if (turnStartPath !== undefined) {
    await confirmTurnStarted(d, opts.name, turnStartPath, sinceTurnStart, env);
  }

  return { sinceMtime };
}

async function mtimeOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// confirmTurnStarted — a TUI can take the paste and its Enter without a turn
// beginning: opencode's autoupdate modal held the keyboard until it was
// answered, so the first prompt went nowhere while send reported success
// (umbel#116). The provider's hook touches its turnStartEvent when a submitted
// prompt starts a turn. No advance in the window means the prompt was lost.
// ---------------------------------------------------------------------------

const TURN_START_POLL_MS = 200;
// opencode reports busy as soon as the prompt is submitted; claude's
// UserPromptSubmit fires at submit. A prompt that started nothing in this
// window never reached the input box.
const TURN_START_TIMEOUT_MS = 10_000;

async function confirmTurnStarted(
  d: Pick<Deps, 'tmux'>,
  name: string,
  path: string,
  sinceMtime: number,
  env: Record<string, string | undefined>,
): Promise<void> {
  const deadline = Date.now() + TURN_START_TIMEOUT_MS;
  for (;;) {
    if ((await mtimeOrZero(path)) > sinceMtime) return;
    // A worker that died in the window did not lose the prompt; report the
    // death. Checked after the signal, so a turn that began before the worker
    // ended still counts as started.
    await assertAlive(d, name, env);
    if (Date.now() >= deadline) {
      const pane = await d.tmux.capturePane(name, 40, env);
      throw new SendTurnNotStartedError(name, pane, TURN_START_TIMEOUT_MS);
    }
    await Bun.sleep(TURN_START_POLL_MS);
  }
}

async function assertAlive(
  d: Pick<Deps, 'tmux'>,
  name: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  // Liveness comes from the worker's pane, not its session: with
  // remain-on-exit the session outlives the worker, so a send to a corpse would
  // otherwise be accepted and silently go nowhere.
  const pane = await d.tmux.paneState(name, env);
  if (!pane.exists) {
    throw new SessionDeadError(name, 'tmux session not found');
  }
  if (pane.dead) {
    throw new SessionDeadError(
      name,
      pane.exitCode !== undefined
        ? `worker exited with status ${pane.exitCode}`
        : 'worker exited without a status (killed by a signal)',
    );
  }
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
