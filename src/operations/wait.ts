import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  formatIdleMessage,
  type IdleSource,
  matchProviderError,
  stillForMs,
} from '../core/idle.ts';
import { classifyNotification, type NeedsInputReason } from '../core/notification.ts';
import { PROVIDERS } from '../core/providers/registry.ts';
import type { Session, WaitCondition } from '../core/types.ts';
import { SessionNameSchema } from '../core/types.ts';
import type { WaitContext } from '../core/wait.ts';
import { applyDefaultTimeout, compile } from '../core/wait.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

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
  inputReason?: NeedsInputReason;
  message?: string;
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
        try {
          const pane = await d.tmux.paneState(name, env);
          alive = pane.exists && !pane.dead;
        } catch {
          // Liveness probe itself failed — assume alive; never report false-dead.
        }
        if (settled) return;
        if (alive) {
          await refreshAlivePane();
          return;
        }
        ctx = await buildCtx();
        if (settled) return;
        if (!syncEvaluate(ctx)) {
          settle({
            stopped: false,
            reason: 'dead',
            ...(lastAlivePane !== undefined && lastAlivePane !== ''
              ? { paneSnapshot: lastAlivePane }
              : {}),
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
