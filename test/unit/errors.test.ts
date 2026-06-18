import { describe, expect, test } from 'bun:test';
import {
  HookTimeoutError,
  JsonlMalformedError,
  SessionDeadError,
  SessionNotFoundError,
  TmuxError,
  UmbelUsageError,
  WaitTimeoutError,
  WorkflowCycleError,
} from '../../src/core/errors.ts';

describe('SessionNotFoundError', () => {
  test('is instanceof Error', () => {
    const err = new SessionNotFoundError('foo');
    expect(err instanceof Error).toBe(true);
  });

  test('name is SessionNotFoundError', () => {
    const err = new SessionNotFoundError('foo');
    expect(err.name).toBe('SessionNotFoundError');
  });

  test('sessionName propagates', () => {
    const err = new SessionNotFoundError('my-session');
    expect(err.sessionName).toBe('my-session');
  });
});

describe('SessionDeadError', () => {
  test('is instanceof Error', () => {
    const err = new SessionDeadError('bar', 'tmux exited');
    expect(err instanceof Error).toBe(true);
  });

  test('name is SessionDeadError', () => {
    const err = new SessionDeadError('bar', 'tmux exited');
    expect(err.name).toBe('SessionDeadError');
  });

  test('sessionName and reason propagate', () => {
    const err = new SessionDeadError('bar', 'killed');
    expect(err.sessionName).toBe('bar');
    expect(err.reason).toBe('killed');
  });
});

describe('HookTimeoutError', () => {
  test('is instanceof Error', () => {
    const err = new HookTimeoutError(30000);
    expect(err instanceof Error).toBe(true);
  });

  test('name is HookTimeoutError', () => {
    const err = new HookTimeoutError(30000);
    expect(err.name).toBe('HookTimeoutError');
  });

  test('waitedMs propagates', () => {
    const err = new HookTimeoutError(5000);
    expect(err.waitedMs).toBe(5000);
  });
});

describe('TmuxError', () => {
  test('is instanceof Error', () => {
    const err = new TmuxError('new-session', 'duplicate session');
    expect(err instanceof Error).toBe(true);
  });

  test('name is TmuxError', () => {
    const err = new TmuxError('new-session', 'duplicate session');
    expect(err.name).toBe('TmuxError');
  });

  test('cmd and stderr propagate', () => {
    const err = new TmuxError('send-keys', 'no server running');
    expect(err.cmd).toBe('send-keys');
    expect(err.stderr).toBe('no server running');
  });
});

describe('JsonlMalformedError', () => {
  test('is instanceof Error', () => {
    const err = new JsonlMalformedError('/tmp/session.jsonl');
    expect(err instanceof Error).toBe(true);
  });

  test('name is JsonlMalformedError', () => {
    const err = new JsonlMalformedError('/tmp/session.jsonl');
    expect(err.name).toBe('JsonlMalformedError');
  });

  test('path propagates', () => {
    const err = new JsonlMalformedError('/home/user/.claude/session.jsonl');
    expect(err.path).toBe('/home/user/.claude/session.jsonl');
  });
});

describe('WorkflowCycleError', () => {
  test('is instanceof Error', () => {
    const err = new WorkflowCycleError(['a', 'b', 'c']);
    expect(err instanceof Error).toBe(true);
  });

  test('name is WorkflowCycleError', () => {
    const err = new WorkflowCycleError(['a', 'b']);
    expect(err.name).toBe('WorkflowCycleError');
  });

  test('workers array propagates', () => {
    const workers = ['reviewer', 'fixer', 'reviewer'];
    const err = new WorkflowCycleError(workers);
    expect(err.workers).toEqual(workers);
  });
});

describe('WaitTimeoutError', () => {
  test('is instanceof Error', () => {
    const err = new WaitTimeoutError({ kind: 'timeout', ms: 1000 });
    expect(err instanceof Error).toBe(true);
  });

  test('name is WaitTimeoutError', () => {
    const err = new WaitTimeoutError({ kind: 'stop', session: 'foo' as never, sinceMtime: 0 });
    expect(err.name).toBe('WaitTimeoutError');
  });

  test('condition propagates', () => {
    const cond = { kind: 'file', path: '/tmp/done' };
    const err = new WaitTimeoutError(cond);
    expect(err.condition).toBe(cond);
  });
});

describe('UmbelUsageError', () => {
  test('is instanceof Error', () => {
    const err = new UmbelUsageError('missing --name');
    expect(err instanceof Error).toBe(true);
  });

  test('name is UmbelUsageError', () => {
    const err = new UmbelUsageError('bad flag');
    expect(err.name).toBe('UmbelUsageError');
  });

  test('message propagates', () => {
    const err = new UmbelUsageError('invalid model: turbo');
    expect(err.message).toBe('invalid model: turbo');
  });
});
