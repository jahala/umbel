import { describe, expect, test } from 'bun:test';
import type { WaitCondition } from '../../src/core/types.ts';
import { applyDefaultTimeout, compile } from '../../src/core/wait.ts';

// Helpers for building mock WaitContext
const baseCtx = {
  fileMtime: (_path: string) => 0,
  fileExists: (_path: string) => false,
  paneText: (_session: string) => '',
  startedAt: 1000,
  now: 2000,
};

function makeCtx(
  overrides: Partial<{
    fileMtime: (path: string) => number;
    fileExists: (path: string) => boolean;
    paneText: (session: string) => string;
    startedAt: number;
    now: number;
  }>,
) {
  return { ...baseCtx, ...overrides };
}

describe('compile — stop', () => {
  test('produces stop-event wake source', () => {
    const cond: WaitCondition = { kind: 'stop', session: 'foo' as never, sinceMtime: 100 };
    const compiled = compile(cond);
    const stopSources = compiled.wakeSources.filter((s) => s.kind === 'stop-event');
    expect(stopSources.length).toBe(1);
    expect(stopSources[0]?.kind === 'stop-event' && stopSources[0].session).toBe('foo');
  });

  test('evaluate returns false when mtime not advanced', () => {
    const cond: WaitCondition = { kind: 'stop', session: 'foo' as never, sinceMtime: 100 };
    const compiled = compile(cond);
    // fileMtime returns 100 (same as sinceMtime) → not yet stopped
    const ctx = makeCtx({ fileMtime: () => 100 });
    expect(compiled.evaluate(ctx)).toBe(false);
  });

  test('evaluate returns true when mtime advanced', () => {
    const cond: WaitCondition = { kind: 'stop', session: 'foo' as never, sinceMtime: 100 };
    const compiled = compile(cond);
    const ctx = makeCtx({ fileMtime: () => 200 });
    expect(compiled.evaluate(ctx)).toBe(true);
  });

  test('evaluate returns true when sinceMtime is 0 and file exists with any mtime', () => {
    const cond: WaitCondition = { kind: 'stop', session: 'bar' as never, sinceMtime: 0 };
    const compiled = compile(cond);
    const ctx = makeCtx({ fileMtime: () => 1 });
    expect(compiled.evaluate(ctx)).toBe(true);
  });
});

describe('compile — file', () => {
  test('produces file wake source with path', () => {
    const cond: WaitCondition = { kind: 'file', path: '/tmp/done' };
    const compiled = compile(cond);
    const fileSources = compiled.wakeSources.filter((s) => s.kind === 'file');
    expect(fileSources.length).toBe(1);
    expect(fileSources[0]?.kind === 'file' && fileSources[0].path).toBe('/tmp/done');
  });

  test('evaluate returns false when file absent', () => {
    const cond: WaitCondition = { kind: 'file', path: '/tmp/done' };
    const compiled = compile(cond);
    const ctx = makeCtx({ fileExists: () => false });
    expect(compiled.evaluate(ctx)).toBe(false);
  });

  test('evaluate returns true when file exists', () => {
    const cond: WaitCondition = { kind: 'file', path: '/tmp/done' };
    const compiled = compile(cond);
    const ctx = makeCtx({ fileExists: () => true });
    expect(compiled.evaluate(ctx)).toBe(true);
  });
});

describe('compile — pattern', () => {
  test('produces pattern wake source', () => {
    const cond: WaitCondition = { kind: 'pattern', session: 'foo' as never, regex: 'DONE' };
    const compiled = compile(cond);
    const patternSources = compiled.wakeSources.filter((s) => s.kind === 'pattern');
    expect(patternSources.length).toBe(1);
    expect(patternSources[0]?.kind === 'pattern' && patternSources[0].session).toBe('foo');
  });

  test('evaluate returns false when pattern not found in pane text', () => {
    const cond: WaitCondition = { kind: 'pattern', session: 'foo' as never, regex: 'DONE' };
    const compiled = compile(cond);
    const ctx = makeCtx({ paneText: () => 'still working...' });
    expect(compiled.evaluate(ctx)).toBe(false);
  });

  test('evaluate returns true when pattern found in pane text', () => {
    const cond: WaitCondition = { kind: 'pattern', session: 'foo' as never, regex: 'DONE' };
    const compiled = compile(cond);
    const ctx = makeCtx({ paneText: () => 'Task DONE! Great.' });
    expect(compiled.evaluate(ctx)).toBe(true);
  });
});

describe('compile — timeout', () => {
  test('produces timer wake source with ms', () => {
    const cond: WaitCondition = { kind: 'timeout', ms: 5000 };
    const compiled = compile(cond);
    const timerSources = compiled.wakeSources.filter((s) => s.kind === 'timer');
    expect(timerSources.length).toBe(1);
    expect(timerSources[0]?.kind === 'timer' && timerSources[0].ms).toBe(5000);
  });

  test('evaluate returns false when elapsed < ms', () => {
    const cond: WaitCondition = { kind: 'timeout', ms: 5000 };
    const compiled = compile(cond);
    // startedAt=1000, now=4000 → elapsed=3000 < 5000
    const ctx = makeCtx({ startedAt: 1000, now: 4000 });
    expect(compiled.evaluate(ctx)).toBe(false);
  });

  test('evaluate returns true when elapsed >= ms', () => {
    const cond: WaitCondition = { kind: 'timeout', ms: 5000 };
    const compiled = compile(cond);
    // startedAt=1000, now=6001 → elapsed=5001 >= 5000
    const ctx = makeCtx({ startedAt: 1000, now: 6001 });
    expect(compiled.evaluate(ctx)).toBe(true);
  });
});

describe('compile — all', () => {
  test('evaluate returns false when any sub-condition is false', () => {
    const cond: WaitCondition = {
      kind: 'all',
      conditions: [
        { kind: 'file', path: '/tmp/a' },
        { kind: 'file', path: '/tmp/b' },
      ],
    };
    const compiled = compile(cond);
    // only /tmp/a exists
    const ctx = makeCtx({ fileExists: (p) => p === '/tmp/a' });
    expect(compiled.evaluate(ctx)).toBe(false);
  });

  test('evaluate returns true when all sub-conditions are true', () => {
    const cond: WaitCondition = {
      kind: 'all',
      conditions: [
        { kind: 'file', path: '/tmp/a' },
        { kind: 'file', path: '/tmp/b' },
      ],
    };
    const compiled = compile(cond);
    const ctx = makeCtx({ fileExists: () => true });
    expect(compiled.evaluate(ctx)).toBe(true);
  });

  test('aggregates wake sources from all children', () => {
    const cond: WaitCondition = {
      kind: 'all',
      conditions: [
        { kind: 'file', path: '/tmp/a' },
        { kind: 'timeout', ms: 3000 },
      ],
    };
    const compiled = compile(cond);
    const fileCount = compiled.wakeSources.filter((s) => s.kind === 'file').length;
    const timerCount = compiled.wakeSources.filter((s) => s.kind === 'timer').length;
    expect(fileCount).toBe(1);
    expect(timerCount).toBe(1);
  });
});

describe('compile — any', () => {
  test('evaluate returns false when all sub-conditions are false', () => {
    const cond: WaitCondition = {
      kind: 'any',
      conditions: [
        { kind: 'file', path: '/tmp/a' },
        { kind: 'file', path: '/tmp/b' },
      ],
    };
    const compiled = compile(cond);
    const ctx = makeCtx({ fileExists: () => false });
    expect(compiled.evaluate(ctx)).toBe(false);
  });

  test('evaluate returns true when any sub-condition is true', () => {
    const cond: WaitCondition = {
      kind: 'any',
      conditions: [
        { kind: 'file', path: '/tmp/a' },
        { kind: 'file', path: '/tmp/b' },
      ],
    };
    const compiled = compile(cond);
    const ctx = makeCtx({ fileExists: (p) => p === '/tmp/a' });
    expect(compiled.evaluate(ctx)).toBe(true);
  });
});

describe('applyDefaultTimeout', () => {
  test('wraps condition with no timeout in any[original, timeout]', () => {
    const cond: WaitCondition = { kind: 'stop', session: 'foo' as never, sinceMtime: 0 };
    const wrapped = applyDefaultTimeout(cond, 30 * 60 * 1000);
    expect(wrapped.kind).toBe('any');
    if (wrapped.kind === 'any') {
      expect(wrapped.conditions).toHaveLength(2);
      expect(wrapped.conditions[0]).toEqual(cond);
      expect(wrapped.conditions[1]).toEqual({ kind: 'timeout', ms: 30 * 60 * 1000 });
    }
  });

  test('does not wrap when condition already has timeout at top level', () => {
    const cond: WaitCondition = { kind: 'timeout', ms: 5000 };
    const result = applyDefaultTimeout(cond, 30 * 60 * 1000);
    expect(result).toEqual(cond);
  });

  test('does not wrap when any contains a timeout', () => {
    const cond: WaitCondition = {
      kind: 'any',
      conditions: [
        { kind: 'stop', session: 'foo' as never, sinceMtime: 0 },
        { kind: 'timeout', ms: 10000 },
      ],
    };
    const result = applyDefaultTimeout(cond, 30 * 60 * 1000);
    expect(result).toEqual(cond);
  });

  test('wraps all condition that has no timeout', () => {
    const cond: WaitCondition = {
      kind: 'all',
      conditions: [
        { kind: 'stop', session: 'foo' as never, sinceMtime: 0 },
        { kind: 'file', path: '/tmp/done' },
      ],
    };
    const wrapped = applyDefaultTimeout(cond, 5000);
    expect(wrapped.kind).toBe('any');
    if (wrapped.kind === 'any') {
      expect(wrapped.conditions[0]).toEqual(cond);
      expect(wrapped.conditions[1]).toEqual({ kind: 'timeout', ms: 5000 });
    }
  });
});
