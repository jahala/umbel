import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type DeathCause, describeDeath } from '../core/death.ts';
import {
  formatIdleMessage,
  type IdleSource,
  matchProviderError,
  stillForMs,
} from '../core/idle.ts';
import { classifyNotification, type NeedsInputReason } from '../core/notification.ts';
import { PROVIDERS } from '../core/providers/registry.ts';
import { signInLine } from '../core/startup-dialogs.ts';
import type { Session, WaitCondition } from '../core/types.ts';
import { SessionNameSchema } from '../core/types.ts';
import type { WaitContext } from '../core/wait.ts';
import { applyDefaultTimeout, compile, deadlineOf } from '../core/wait.ts';
import { readDeathCause } from './death-record.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';
import { readTranscriptAtStop, TURN_END_SETTLE_MS } from './resolve-transcript.ts';

// Re-export WaitCondition for convenience at call sites
export type { WaitCondition };

// ---------------------------------------------------------------------------
// WaitOpts / WaitResult
// ---------------------------------------------------------------------------

export interface WaitOpts {
  name: string;
  condition?: WaitCondition;
  sinceMtime?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  defaultTimeoutMs?: number;
  // Opt-in universal idle net: if nothing the worker touches moves for this many
  // ms — its tmux pane, its events dir, its transcript tree — settle
  // reason:'idle' + paneSnapshot. Catches a worker blocked on a prompt (or hung)
  // on providers without a Notification hook. Off when undefined — a worker may
  // legitimately run a long silent tool call.
  idleTimeoutMs?: number;
  deps?: Partial<Deps>;
}

export interface WaitResult {
  stopped: boolean;
  reason:
    | 'stop'
    | 'file'
    | 'pattern'
    | 'timeout'
    | 'aborted'
    | 'dead'
    | 'input'
    | 'idle'
    | 'provider-error';
  // When reason is 'input', the worker is awaiting the user. `inputReason` is the
  // classified sub-reason (permission = blocked on a tool prompt, idle = done +
  // idle, question = elicitation); `message` carries the prompt text — so the
  // caller can branch without screen-scraping the pane. When reason is 'idle',
  // `message` names each watched source and how long it has been still; when
  // 'provider-error', it is the pane line matching the provider's errorMatch.
  // When 'stop', it is present only if the worker's final message had not reached
  // the transcript when the settle window closed, so a read may lag the handback.
  inputReason?: NeedsInputReason;
  message?: string;
  // When reason is 'dead', the status the worker's process exited with, read
  // from its pane. Absent when it died by a signal: tmux records no status for
  // one, and `message` names the signal instead.
  exitCode?: number;
  // On timeout (and 'input'), a best-effort snapshot of the tmux pane at the
  // moment the wait settled — so a stuck worker's cause (e.g. an unexpected
  // provider dialog) is visible. Absent for clean reasons and when capture fails.
  paneSnapshot?: string;
}

// ---------------------------------------------------------------------------
// inspectReason — determine which sub-condition triggered a true evaluate
// ---------------------------------------------------------------------------

function inspectReason(condition: WaitCondition, ctx: WaitContext): WaitResult['reason'] {
  switch (condition.kind) {
    case 'stop':
      return 'stop';
    case 'file':
      return 'file';
    case 'pattern':
      return 'pattern';
    case 'timeout':
      return 'timeout';
    case 'all':
    case 'any': {
      // First child that evaluates true determines the reason
      for (const child of condition.conditions) {
        const childCompiled = compile(child);
        if (childCompiled.evaluate(ctx)) {
          return inspectReason(child, ctx);
        }
      }
      // Unreachable if called only when overall evaluates true —
      // default to 'stop' as a safe fallback.
      return 'stop';
    }
  }
}

// ---------------------------------------------------------------------------
// waitFor
// ---------------------------------------------------------------------------

// How often a wait re-captures the pane while the worker is alive. Only the
// most recent view is kept, and only a death ever reads it, so this trades a
// couple of seconds of staleness against spawning a tmux process every poll.
const ALIVE_PANE_CAPTURE_MS = 2000;
// How long a dead pane may go unrecorded before the death is read as such
// (tmux records the status or signal moments after the pty closes), and how
// often to look meanwhile.
const DEAD_RECORD_SETTLE_MS = 1000;
const DEAD_RECORD_POLL_MS = 100;
// How long past its deadline a wait may spend capturing the pane for its
// timeout. A tmux that has not answered by then no longer holds the wait
// (umbel#98).
export const DEADLINE_GRACE_MS = 2000;

// Transcript discovery scans a directory, so the idle net retries it only every
// few polls while the hook has not yet told us where the transcript lives.
const TRANSCRIPT_DISCOVERY_EVERY_POLLS = 4;

// A file's mtime, or for a directory the newest mtime among it and its entries
// (an append changes the file, not the directory). 0 when absent.
async function newestMtime(path: string): Promise<number> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(path);
  } catch {
    return 0;
  }
  if (!s.isDirectory()) return s.mtimeMs;
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return s.mtimeMs;
  }
  const mtimes = await Promise.all(
    entries.map((e) =>
      stat(join(path, e)).then(
        (es) => es.mtimeMs,
        () => 0,
      ),
    ),
  );
  return Math.max(s.mtimeMs, ...mtimes);
}

export async function waitFor(opts: WaitOpts): Promise<WaitResult> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};
  const name = opts.name;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 30 * 60 * 1000;

  // Build condition — default: stop with default timeout
  const rawCondition: WaitCondition = opts.condition ?? {
    kind: 'stop',
    session: SessionNameSchema.parse(name),
    sinceMtime: opts.sinceMtime ?? 0,
  };

  const condition = applyDefaultTimeout(rawCondition, defaultTimeoutMs);
  const { evaluate, wakeSources } = compile(condition);
  const deadlineMs = deadlineOf(condition);

  const startedAt = Date.now();

  // Internal abort controller — we drive cleanup through this
  const internalAc = new AbortController();

  // Forward external signal to internal abort
  let externalAbortHandler: (() => void) | undefined;
  if (opts.signal !== undefined) {
    const externalSignal = opts.signal;
    externalAbortHandler = () => internalAc.abort();
    externalSignal.addEventListener('abort', externalAbortHandler);
  }

  // Build a snapshot-based WaitContext from the current filesystem state.
  // All paths evaluated by the stop predicate are relative like
  // "sessions/<name>/events/stop"; we resolve them via stateDir.
  async function buildCtx(): Promise<WaitContext> {
    const stateRoot = d.fs.stateDir(env);

    async function fileMtime(path: string): Promise<number> {
      const resolved = path.startsWith('/') ? path : join(stateRoot, path);
      try {
        const s = await stat(resolved);
        return s.mtimeMs;
      } catch {
        return 0;
      }
    }

    async function fileExists(path: string): Promise<boolean> {
      const resolved = path.startsWith('/') ? path : join(stateRoot, path);
      try {
        await stat(resolved);
        return true;
      } catch {
        return false;
      }
    }

    async function paneText(session: string): Promise<string> {
      try {
        return await d.tmux.capturePane(session, 200, env);
      } catch {
        return '';
      }
    }

    const now = Date.now();

    // Gather all async values for the context snapshot
    const mtimePaths: string[] = [];
    const existPaths: string[] = [];
    const paneSessions: string[] = [];

    for (const ws of wakeSources) {
      if (ws.kind === 'stop-event') {
        mtimePaths.push(`sessions/${ws.session}/events/stop`);
      } else if (ws.kind === 'file') {
        existPaths.push(ws.path);
      } else if (ws.kind === 'pattern') {
        paneSessions.push(ws.session);
      }
    }

    const [mtimes, exists, panes] = await Promise.all([
      Promise.all(mtimePaths.map(fileMtime)),
      Promise.all(existPaths.map(fileExists)),
      Promise.all(paneSessions.map(paneText)),
    ]);

    const mtimeMap = new Map(mtimePaths.map((p, i) => [p, mtimes[i] ?? 0]));
    const existMap = new Map(existPaths.map((p, i) => [p, exists[i] ?? false]));
    const paneMap = new Map(paneSessions.map((s, i) => [s, panes[i] ?? '']));

    return {
      fileMtime: (p) => mtimeMap.get(p) ?? 0,
      fileExists: (p) => existMap.get(p) ?? false,
      paneText: (s) => paneMap.get(s) ?? '',
      startedAt,
      now,
    };
  }

  // Synchronous evaluate helper with a snapshot ctx
  function syncEvaluate(ctx: WaitContext): boolean {
    return evaluate(ctx);
  }

  // Collect watch paths from wake sources
  const watchPaths: string[] = [];
  const stateRoot = d.fs.stateDir(env);

  for (const ws of wakeSources) {
    if (ws.kind === 'stop-event') {
      // Watch the events dir (stop file may not exist yet)
      watchPaths.push(join(stateRoot, 'sessions', ws.session, 'events'));
    } else if (ws.kind === 'file') {
      // Watch the parent dir of the target file
      const resolvedPath = ws.path.startsWith('/') ? ws.path : join(stateRoot, ws.path);
      watchPaths.push(join(resolvedPath, '..'));
    }
    // timer and pattern wake sources are handled differently (timer/interval)
  }

  // Notification baseline: a touch of events/notification AFTER this point means
  // the worker is blocked asking for input (permission prompt / idle). Captured
  // at wait start — the send→wait gap is far shorter than the time a worker takes
  // to reach a prompt. Orthogonal early-exit, like the 'dead' liveness check.
  const notificationPath = join(stateRoot, 'sessions', name, 'events', 'notification');
  const readNotificationMtime = async (): Promise<number> => {
    try {
      return (await stat(notificationPath)).mtimeMs;
    } catch {
      return 0;
    }
  };
  let notificationSince = await readNotificationMtime();

  // Resolve promise that fires when the condition is met or aborted
  return new Promise<WaitResult>((resolve) => {
    let settled = false;

    // A worker that dies takes its pane with it: by the time the liveness probe
    // notices, there is nothing left to capture, which is why 'dead' carried no
    // diagnostics at all. Keep the last view from while it was alive. Throttled
    // so a long wait does not spawn a tmux process on every poll.
    let lastAlivePane: string | undefined;
    let lastAlivePaneAt = 0;
    async function refreshAlivePane(): Promise<void> {
      if (Date.now() - lastAlivePaneAt < ALIVE_PANE_CAPTURE_MS) return;
      lastAlivePaneAt = Date.now();
      try {
        lastAlivePane = await d.tmux.capturePane(name, 30, env);
      } catch {
        // Capture failed — keep whatever earlier view we already hold.
      }
    }

    // The worker's sign-in screen, from its provider, read from meta once. A
    // failed read is not kept, so the next check tries again.
    let signInScreen: Promise<{ provider: string; match: RegExp } | undefined> | undefined;
    function signInScreenOf(): Promise<{ provider: string; match: RegExp } | undefined> {
      signInScreen ??= d.fs.readMeta(name, env).then(
        (meta) => {
          const match = PROVIDERS[meta.provider]?.signInMatch;
          return match === undefined ? undefined : { provider: meta.provider, match };
        },
        () => {
          signInScreen = undefined;
          return undefined;
        },
      );
      return signInScreen;
    }

    // Claude fires its Stop hook before it writes the turn's final message, so a
    // stop seen here can precede the handback by a few hundred ms (umbel#86).
    // 'stop' is reported once the handback is readable; if the window closes
    // first, the message says a read may return an earlier message.
    // handbackGap must never reject: once stopHeld is set, 'stop' outranks the
    // deadline, so a rejection would leave the wait holding forever.
    let stopHeld = false;
    async function handbackGap(): Promise<string | undefined> {
      let meta: Session;
      try {
        meta = await d.fs.readMeta(name, env);
      } catch {
        return undefined;
      }
      const provider = PROVIDERS[meta.provider];
      if (provider?.turnEnded === undefined) return undefined;
      try {
        const { ended } = await readTranscriptAtStop({
          name,
          cwd: meta.cwd,
          sinceMs: meta.createdAt,
          provider,
          env,
          ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
        });
        if (ended) return undefined;
      } catch {
        // Unreadable transcript: report the stop and say why the handback may lag.
      }
      return `the worker stopped, but its final message was not in the transcript within ${TURN_END_SETTLE_MS / 1000}s; read may return an earlier message`;
    }

    function settle(result: WaitResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    // Cleanup registry
    const cleanupFns: Array<() => void> = [];

    function cleanup(): void {
      internalAc.abort();
      for (const fn of cleanupFns) {
        fn();
      }
      if (opts.signal !== undefined && externalAbortHandler !== undefined) {
        opts.signal.removeEventListener('abort', externalAbortHandler);
      }
    }

    // If external signal already aborted, settle immediately
    if (opts.signal?.aborted) {
      settle({ stopped: false, reason: 'aborted' });
      return;
    }

    // Internal abort → aborted result
    internalAc.signal.addEventListener('abort', () => {
      if (!settled) {
        // Only settle with aborted if externally triggered
        if (opts.signal?.aborted) {
          settle({ stopped: false, reason: 'aborted' });
        }
      }
    });

    // Central re-evaluate: build ctx snapshot async then check
    async function check(): Promise<void> {
      if (settled) return;
      let ctx = await buildCtx();
      if (settled) return;

      if (!syncEvaluate(ctx)) {
        // Before treating "not stopped" as "still working", check whether the
        // worker is BLOCKED asking for input (permission prompt / idle). The
        // Notification hook touches events/notification; surface it promptly as
        // 'input' (with the message) so the caller can answer instead of waiting
        // out the timeout. Checked before liveness — a blocked worker is alive.
        const notifMtime = await readNotificationMtime();
        if (settled) return;
        if (notifMtime > notificationSince) {
          let content = '';
          try {
            content = await readFile(notificationPath, 'utf8');
          } catch {
            // notification file vanished between stat and read — treat as empty.
          }
          const cls = classifyNotification(content);
          if (cls.reason !== null) {
            let paneSnapshot: string | undefined;
            try {
              paneSnapshot = await d.tmux.capturePane(name, 30, env);
            } catch {
              // pane capture failed — settle without it.
            }
            if (settled) return;
            settle({
              stopped: false,
              reason: 'input',
              inputReason: cls.reason,
              ...(cls.message !== undefined ? { message: cls.message } : {}),
              ...(paneSnapshot !== undefined ? { paneSnapshot } : {}),
            });
            return;
          }
          // Informational notification (auth_success / elicitation completion) —
          // advance the baseline so it isn't re-evaluated, and keep waiting.
          notificationSince = notifMtime;
        }

        // Condition not met yet. If the worker's pane is dead — or its session
        // has vanished entirely — it crashed or exited without ever firing the
        // stop hook, so no future wake can satisfy the condition. The pane is
        // what is asked: remain-on-exit keeps the session standing after the
        // worker is gone. Re-check the condition once AFTER confirming death
        // (the worker may have fired stop in the instant before exiting); only
        // then give up with 'dead'.
        let alive = true;
        let cause: DeathCause = { exists: false };
        try {
          let pane = await d.tmux.paneState(name, env);
          // How it died is read from events/exit, which the launch wrapper
          // writes before it ends, and from tmux's pane status only when that
          // is absent. Either can trail the dead pane by a moment — the
          // record's rename, or tmux reaping the child (#89) — so give both
          // that moment, bounded, before reading the death as unrecorded.
          const settleBy = Date.now() + DEAD_RECORD_SETTLE_MS;
          const causeOf = async (p: typeof pane): Promise<DeathCause> =>
            p.exists && !p.dead ? p : readDeathCause(d, name, p, env);
          cause = await causeOf(pane);
          while (
            pane.exists &&
            pane.dead &&
            cause.exitCode === undefined &&
            cause.signal === undefined &&
            Date.now() < settleBy
          ) {
            await Bun.sleep(DEAD_RECORD_POLL_MS);
            if (settled) return;
            pane = await d.tmux.paneState(name, env);
            cause = await causeOf(pane);
          }
          alive = pane.exists && !pane.dead;
        } catch {
          // Liveness probe itself failed — assume alive; never report false-dead.
        }
        if (settled) return;
        if (alive) {
          await refreshAlivePane();
          // A live worker on its sign-in screen is asking a person to act, and
          // will until one does: its credentials expired, or it never had any.
          // Waiting out the deadline gave a conductor a timeout to retry, and
          // the retry met the same screen (umbel#105).
          const screen = await signInScreenOf();
          const line = signInLine(lastAlivePane ?? '', screen?.match);
          if (screen !== undefined && line !== undefined && lastAlivePane !== undefined) {
            settle({
              stopped: false,
              reason: 'input',
              inputReason: 'sign-in',
              message: `${screen.provider} is asking a person to sign in: "${line}"`,
              paneSnapshot: lastAlivePane,
            });
          }
          return;
        }
        ctx = await buildCtx();
        if (settled) return;
        if (!syncEvaluate(ctx)) {
          // The pane outlives the process, so the last screen can be read exactly
          // rather than sampled: capture it now. The view kept from while the
          // worker was alive is the fallback for a session gone entirely.
          let paneSnapshot: string | undefined;
          try {
            paneSnapshot = await d.tmux.capturePane(name, 30, env);
          } catch {
            // Nothing left to capture — the remains were swept.
          }
          if (paneSnapshot === undefined || paneSnapshot === '') paneSnapshot = lastAlivePane;
          if (settled) return;
          const evidence = {
            ...(cause.exitCode !== undefined ? { exitCode: cause.exitCode } : {}),
            ...(paneSnapshot !== undefined && paneSnapshot !== '' ? { paneSnapshot } : {}),
          };
          // The death outlives this process: written down so a post-mortem needs
          // only the session directory. Best-effort — the result below carries
          // the same evidence, so an unwritable state dir costs the record, not
          // the wait.
          try {
            await d.fs.writeDead(name, { at: Date.now(), ...evidence }, env);
          } catch {
            // State dir gone or unwritable.
          }
          if (settled) return;
          settle({
            stopped: false,
            reason: 'dead',
            message: describeDeath(cause),
            ...evidence,
          });
          return;
        }
        // Condition was satisfied in the race window — fall through to settle.
      }

      const reason = inspectReason(condition, ctx);
      if (reason === 'timeout') {
        // Best-effort pane snapshot for diagnostics before giving up.
        let paneSnapshot: string | undefined;
        try {
          paneSnapshot = await d.tmux.capturePane(name, 30, env);
        } catch {
          // capture failed (session gone, tmux error) — settle without it.
        }
        if (settled) return;
        settle({
          stopped: false,
          reason,
          ...(paneSnapshot !== undefined ? { paneSnapshot } : {}),
        });
      } else if (reason === 'stop') {
        if (stopHeld) return;
        stopHeld = true;
        const message = await handbackGap();
        if (settled) return;
        settle({ stopped: true, reason, ...(message !== undefined ? { message } : {}) });
      } else {
        settle({ stopped: true, reason });
      }
    }

    // Initial check — predicate may already be satisfied
    void check();

    // Set up fs.watch for file-based wake sources
    if (watchPaths.length > 0) {
      const watcher = d.watch(watchPaths, internalAc.signal);
      cleanupFns.push(() => {
        // The watcher is cleaned up via internalAc.signal abort
      });
      void (async () => {
        try {
          for await (const _event of watcher) {
            if (settled) break;
            await check();
          }
        } catch {
          // Watcher closed; ignore
        }
      })();
    }

    // Set up timer for timeout wake sources
    for (const ws of wakeSources) {
      if (ws.kind === 'timer') {
        const handle = setTimeout(() => {
          void check();
        }, ws.ms);
        cleanupFns.push(() => clearTimeout(handle));
      }
    }

    // The deadline settles through check(), and check() awaits tmux. When tmux
    // does not answer, no check finishes and nothing else would end the wait: a
    // wait asked for 120s held for 46 minutes (umbel#98). So the deadline also
    // ends the wait on its own, with the last pane seen alive. A stop already
    // being read out outranks it, and that read is bounded.
    if (deadlineMs !== undefined) {
      const handle = setTimeout(() => {
        if (settled || stopHeld) return;
        const pane =
          lastAlivePane === undefined
            ? 'no pane was captured'
            : 'the pane shown is the last one seen while the worker was alive';
        settle({
          stopped: false,
          reason: 'timeout',
          message: `tmux did not answer within ${DEADLINE_GRACE_MS / 1000}s of the deadline; ${pane}`,
          ...(lastAlivePane !== undefined ? { paneSnapshot: lastAlivePane } : {}),
        });
      }, deadlineMs + DEADLINE_GRACE_MS);
      cleanupFns.push(() => clearTimeout(handle));
    }

    // Set up polling interval for pattern wake sources
    for (const ws of wakeSources) {
      if (ws.kind === 'pattern') {
        const handle = setInterval(() => {
          void check();
        }, 500);
        cleanupFns.push(() => clearInterval(handle));
      }
    }

    // Liveness poll — a worker can die mid-wait without firing stop and without
    // touching a watched file, so no fs.watch or timer wake would fire. Poll
    // the session's existence (500ms) so a dead worker resolves promptly.
    const livenessHandle = setInterval(() => {
      void check();
    }, 500);
    cleanupFns.push(() => clearInterval(livenessHandle));

    // Idle net (opt-in): settle 'idle' when no activity source has moved for
    // idleTimeoutMs. Sources are the pane, the events dir (every hook fire lands
    // there) and the transcript tree, including a claude worker's subagent
    // transcripts — a subagent can work for minutes behind a silent pane. Any
    // source moving resets the timer; an unresolvable source contributes no time
    // and the message names it unresolved.
    const idleMs = opts.idleTimeoutMs;
    if (idleMs !== undefined) {
      let lastPane: string | undefined;
      let paneChangedAt = Date.now();
      let idlePolls = 0;
      let discoveredTranscript: string | undefined;
      const eventsDir = d.fs.eventsDir(name, env);

      // Cheap sources first (meta, the hook-captured path); discovery only every
      // few polls, and never for providers whose transcript is not a file.
      const resolveTranscript = async (
        meta: Session,
        poll: number,
      ): Promise<string | undefined> => {
        if (meta.jsonlPath !== null && meta.jsonlPath !== '') return meta.jsonlPath;
        try {
          const hooked = (await readFile(join(eventsDir, 'transcript-path'), 'utf8')).trim();
          if (hooked !== '') return hooked;
        } catch {
          // No hook has fired yet — fall through to discovery.
        }
        if (discoveredTranscript !== undefined) return discoveredTranscript;
        if (poll % TRANSCRIPT_DISCOVERY_EVERY_POLLS !== 0) return undefined;
        if (PROVIDERS[meta.provider]?.exportTranscript !== undefined) return undefined;
        try {
          discoveredTranscript = await d.jsonl.discoverSessionJsonl({
            sessionName: name,
            cwd: meta.cwd,
            sinceMs: meta.createdAt,
            timeoutMs: 0,
          });
        } catch {
          // Not on disk yet — contributes nothing this poll.
        }
        return discoveredTranscript;
      };

      // The pane has no timestamp, so its last change is when this wait first saw
      // its current text. File sources carry their own: the newest mtime.
      const onDisk = (mtime: number): IdleSource['lastChangeAt'] =>
        mtime === 0 ? 'absent' : mtime;

      const fileSources = async (poll: number): Promise<IdleSource[]> => {
        let meta: Session | undefined;
        try {
          meta = await d.fs.readMeta(name, env);
        } catch {
          meta = undefined;
        }
        const transcript = meta === undefined ? undefined : await resolveTranscript(meta, poll);
        const subagentDir =
          meta === undefined ? undefined : PROVIDERS[meta.provider]?.subagentTranscriptDir;
        const [events, transcriptMtime, subagentsMtime] = await Promise.all([
          newestMtime(eventsDir),
          transcript === undefined ? 0 : newestMtime(transcript),
          transcript === undefined || subagentDir === undefined
            ? 0
            : newestMtime(subagentDir(transcript)),
        ]);
        const unresolvedOr = (mtime: number): IdleSource['lastChangeAt'] =>
          transcript === undefined ? 'unresolved' : onDisk(mtime);
        return [
          { name: 'events', lastChangeAt: onDisk(events) },
          { name: 'transcript', lastChangeAt: unresolvedOr(transcriptMtime) },
          ...(subagentDir === undefined
            ? []
            : [{ name: 'subagents', lastChangeAt: unresolvedOr(subagentsMtime) }]),
        ];
      };

      const idlePollMs = Math.max(250, Math.min(2000, Math.floor(idleMs / 4)));
      // A provider error settles once the pane has held still this long: long
      // enough to tell a dead end from a retry printing on, far below idleMs.
      const errorGraceMs = Math.min(idleMs, Math.max(2 * idlePollMs, 3000));
      let errorMatch: readonly RegExp[] | undefined;
      const idleHandle = setInterval(() => {
        void (async () => {
          if (settled) return;
          let pane: string;
          try {
            pane = await d.tmux.capturePane(name, 50, env);
          } catch {
            return;
          }
          const files = await fileSources(idlePolls++);
          if (settled) return;
          const now = Date.now();
          if (pane !== lastPane) {
            lastPane = pane;
            paneChangedAt = now;
          }
          if (errorMatch === undefined) {
            try {
              errorMatch = PROVIDERS[(await d.fs.readMeta(name, env)).provider]?.errorMatch ?? [];
            } catch {
              // Meta unreadable this poll — try again next poll.
            }
            if (settled) return;
          }
          const errorLine = matchProviderError(pane, errorMatch ?? []);
          if (errorLine !== undefined && now - paneChangedAt >= errorGraceMs) {
            settle({
              stopped: false,
              reason: 'provider-error',
              message: errorLine,
              paneSnapshot: pane,
            });
            return;
          }
          const sources: IdleSource[] = [{ name: 'pane', lastChangeAt: paneChangedAt }, ...files];
          if ((stillForMs(sources, now) ?? 0) >= idleMs) {
            settle({
              stopped: false,
              reason: 'idle',
              message: formatIdleMessage(sources, now),
              ...(pane !== '' ? { paneSnapshot: pane } : {}),
            });
          }
        })();
      }, idlePollMs);
      cleanupFns.push(() => clearInterval(idleHandle));
    }

    // External signal handling is wired via internalAc. The internal-abort
    // listener settles with reason='aborted' when opts.signal triggers the
    // abort. A redundant external listener here would leak.
  });
}
