import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WaitCondition } from '../core/types.ts';
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
  deps?: Partial<Deps>;
}

export interface WaitResult {
  stopped: boolean;
  reason: 'stop' | 'file' | 'pattern' | 'timeout' | 'aborted' | 'dead';
  // On timeout, a best-effort snapshot of the tmux pane at the moment the wait
  // gave up — so a stuck worker's cause (e.g. an unexpected provider dialog
  // blocking the turn) is visible instead of a bare "timed out". Absent for
  // non-timeout reasons and when capture fails.
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
        return await d.tmux.capturePane(session, 200);
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

  // Resolve promise that fires when the condition is met or aborted
  return new Promise<WaitResult>((resolve) => {
    let settled = false;

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
        // Condition not met yet. If the worker's tmux session has vanished it
        // crashed or exited without ever firing the stop hook, so no future
        // wake can satisfy the condition. Re-check the condition once AFTER
        // confirming death (the worker may have fired stop in the instant
        // before exiting); only then give up with 'dead'.
        let alive = true;
        try {
          alive = await d.tmux.hasSession(name);
        } catch {
          // Liveness probe itself failed — assume alive; never report false-dead.
        }
        if (settled) return;
        if (alive) return;
        ctx = await buildCtx();
        if (settled) return;
        if (!syncEvaluate(ctx)) {
          settle({ stopped: false, reason: 'dead' });
          return;
        }
        // Condition was satisfied in the race window — fall through to settle.
      }

      const reason = inspectReason(condition, ctx);
      if (reason === 'timeout') {
        // Best-effort pane snapshot for diagnostics before giving up.
        let paneSnapshot: string | undefined;
        try {
          paneSnapshot = await d.tmux.capturePane(name, 30);
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

    // External signal handling is wired via internalAc. The internal-abort
    // listener settles with reason='aborted' when opts.signal triggers the
    // abort. A redundant external listener here would leak.
  });
}
