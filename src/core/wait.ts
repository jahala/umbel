import type { WaitCondition } from './types.ts';

// ---------------------------------------------------------------------------
// Wake sources — symbolic. The operations layer resolves stop-event → path.
// ---------------------------------------------------------------------------

export type WakeSource =
  | { kind: 'stop-event'; session: string }
  | { kind: 'file'; path: string }
  | { kind: 'pattern'; session: string }
  | { kind: 'timer'; ms: number };

// ---------------------------------------------------------------------------
// WaitContext — pure snapshot provided by the operations layer at evaluate time
// ---------------------------------------------------------------------------

export interface WaitContext {
  fileMtime: (path: string) => number;
  fileExists: (path: string) => boolean;
  paneText: (session: string) => string;
  startedAt: number;
  now: number;
}

// ---------------------------------------------------------------------------
// CompiledWait — evaluate is pure given a WaitContext snapshot
// ---------------------------------------------------------------------------

export interface CompiledWait {
  evaluate: (ctx: WaitContext) => boolean;
  wakeSources: WakeSource[];
}

// ---------------------------------------------------------------------------
// compile — pure, no I/O
// ---------------------------------------------------------------------------

export function compile(cond: WaitCondition): CompiledWait {
  switch (cond.kind) {
    case 'stop': {
      const { session, sinceMtime } = cond;
      return {
        wakeSources: [{ kind: 'stop-event', session }],
        evaluate: (ctx) => ctx.fileMtime(`sessions/${session}/events/stop`) > sinceMtime,
      };
    }

    case 'file': {
      const { path } = cond;
      return {
        wakeSources: [{ kind: 'file', path }],
        evaluate: (ctx) => ctx.fileExists(path),
      };
    }

    case 'pattern': {
      const { session, regex } = cond;
      const re = new RegExp(regex);
      return {
        wakeSources: [{ kind: 'pattern', session }],
        evaluate: (ctx) => re.test(ctx.paneText(session)),
      };
    }

    case 'timeout': {
      const { ms } = cond;
      return {
        wakeSources: [{ kind: 'timer', ms }],
        evaluate: (ctx) => ctx.now - ctx.startedAt >= ms,
      };
    }

    case 'all': {
      const children = cond.conditions.map(compile);
      return {
        wakeSources: children.flatMap((c) => c.wakeSources),
        evaluate: (ctx) => children.every((c) => c.evaluate(ctx)),
      };
    }

    case 'any': {
      const children = cond.conditions.map(compile);
      return {
        wakeSources: children.flatMap((c) => c.wakeSources),
        evaluate: (ctx) => children.some((c) => c.evaluate(ctx)),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// hasTimeout — tree walk to detect any timeout variant
// ---------------------------------------------------------------------------

function hasTimeout(cond: WaitCondition): boolean {
  if (cond.kind === 'timeout') return true;
  if (cond.kind === 'all' || cond.kind === 'any') {
    return cond.conditions.some(hasTimeout);
  }
  return false;
}

// ---------------------------------------------------------------------------
// applyDefaultTimeout — wrap in any[original, timeout] if no timeout present
// ---------------------------------------------------------------------------

export function applyDefaultTimeout(cond: WaitCondition, defaultMs: number): WaitCondition {
  if (hasTimeout(cond)) return cond;
  return {
    kind: 'any',
    conditions: [cond, { kind: 'timeout', ms: defaultMs }],
  };
}

// ---------------------------------------------------------------------------
// deadlineOf: the time after which the condition holds whatever else happens
// ---------------------------------------------------------------------------

// PURE. A timeout ends the wait on its own at the top or inside `any`. Inside
// `all` it only asks for time to have passed alongside the rest, so it sets no
// deadline.
export function deadlineOf(cond: WaitCondition): number | undefined {
  if (cond.kind === 'timeout') return cond.ms;
  if (cond.kind !== 'any') return undefined;
  const deadlines = cond.conditions.map(deadlineOf).filter((ms): ms is number => ms !== undefined);
  return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}
