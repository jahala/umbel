import { describe, expect, test } from 'bun:test';
import {
  SessionNameSchema,
  SessionSchema,
  WaitConditionSchema,
  WorkflowSpecSchema,
} from '../../src/core/types.ts';

describe('SessionNameSchema', () => {
  test('parses valid session name', () => {
    const result = SessionNameSchema.safeParse('my-session');
    expect(result.success).toBe(true);
  });

  test('rejects leading dash', () => {
    const result = SessionNameSchema.safeParse('-bad');
    expect(result.success).toBe(false);
  });

  test('rejects uppercase', () => {
    const result = SessionNameSchema.safeParse('MySession');
    expect(result.success).toBe(false);
  });

  test('rejects name over 63 chars', () => {
    const result = SessionNameSchema.safeParse('a'.repeat(64));
    expect(result.success).toBe(false);
  });

  test('accepts 63-char name', () => {
    const result = SessionNameSchema.safeParse(`a${'b'.repeat(62)}`);
    expect(result.success).toBe(true);
  });
});

describe('SessionSchema', () => {
  const validSession = {
    name: 'my-session',
    cwd: '/home/user/project',
    anonymous: false,
    createdAt: 1700000000,
    jsonlPath: null,
  };

  test('parses valid session', () => {
    const result = SessionSchema.safeParse(validSession);
    expect(result.success).toBe(true);
  });

  test('parses session with optional model', () => {
    const result = SessionSchema.safeParse({ ...validSession, model: 'sonnet' });
    expect(result.success).toBe(true);
  });

  test('rejects invalid model', () => {
    const result = SessionSchema.safeParse({ ...validSession, model: 'gpt-4' });
    expect(result.success).toBe(false);
  });

  test('rejects missing cwd', () => {
    const { cwd: _cwd, ...rest } = validSession;
    const result = SessionSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test('rejects missing anonymous', () => {
    const { anonymous: _anonymous, ...rest } = validSession;
    const result = SessionSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test('rejects missing createdAt', () => {
    const { createdAt: _createdAt, ...rest } = validSession;
    const result = SessionSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test('accepts null jsonlPath', () => {
    const result = SessionSchema.safeParse({ ...validSession, jsonlPath: null });
    expect(result.success).toBe(true);
  });

  test('accepts string jsonlPath', () => {
    const result = SessionSchema.safeParse({
      ...validSession,
      jsonlPath: '/home/user/.claude/projects/-home-user-project/abc123.jsonl',
    });
    expect(result.success).toBe(true);
  });

  test('rejects negative createdAt', () => {
    const result = SessionSchema.safeParse({ ...validSession, createdAt: -1 });
    expect(result.success).toBe(false);
  });
});

describe('WaitConditionSchema — stop', () => {
  test('parses stop condition', () => {
    const result = WaitConditionSchema.safeParse({
      kind: 'stop',
      session: 'my-session',
      sinceMtime: 0,
    });
    expect(result.success).toBe(true);
  });

  test('rejects stop without sinceMtime', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'stop', session: 'my-session' });
    expect(result.success).toBe(false);
  });
});

describe('WaitConditionSchema — file', () => {
  test('parses file condition', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'file', path: '/tmp/done' });
    expect(result.success).toBe(true);
  });

  test('rejects file without path', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'file' });
    expect(result.success).toBe(false);
  });
});

describe('WaitConditionSchema — pattern', () => {
  test('parses pattern condition', () => {
    const result = WaitConditionSchema.safeParse({
      kind: 'pattern',
      session: 'my-session',
      regex: 'DONE',
    });
    expect(result.success).toBe(true);
  });
});

describe('WaitConditionSchema — timeout', () => {
  test('parses timeout condition', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'timeout', ms: 30000 });
    expect(result.success).toBe(true);
  });

  test('rejects timeout with ms <= 0', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'timeout', ms: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects negative ms', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'timeout', ms: -1 });
    expect(result.success).toBe(false);
  });
});

describe('WaitConditionSchema — all/any (recursive)', () => {
  test('parses all condition', () => {
    const result = WaitConditionSchema.safeParse({
      kind: 'all',
      conditions: [
        { kind: 'stop', session: 'foo', sinceMtime: 0 },
        { kind: 'file', path: '/tmp/out.md' },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('parses any condition', () => {
    const result = WaitConditionSchema.safeParse({
      kind: 'any',
      conditions: [
        { kind: 'timeout', ms: 60000 },
        { kind: 'stop', session: 'bar', sinceMtime: 100 },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('rejects empty conditions array in all', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'all', conditions: [] });
    expect(result.success).toBe(false);
  });

  test('rejects empty conditions array in any', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'any', conditions: [] });
    expect(result.success).toBe(false);
  });

  test('accepts nested all/any', () => {
    const result = WaitConditionSchema.safeParse({
      kind: 'all',
      conditions: [
        {
          kind: 'any',
          conditions: [
            { kind: 'stop', session: 'a', sinceMtime: 0 },
            { kind: 'timeout', ms: 5000 },
          ],
        },
        { kind: 'file', path: '/tmp/ready' },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('rejects unknown kind', () => {
    const result = WaitConditionSchema.safeParse({ kind: 'never', conditions: [] });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowSpecSchema', () => {
  const validWorker = { cwd: '/tmp/work' };
  const validStep = {
    run: 'reviewer',
    prompt: 'Review the code',
  };

  test('parses minimal valid workflow', () => {
    const result = WorkflowSpecSchema.safeParse({
      workers: { reviewer: validWorker },
      steps: [validStep],
    });
    expect(result.success).toBe(true);
  });

  test('rejects empty steps array', () => {
    const result = WorkflowSpecSchema.safeParse({
      workers: { reviewer: validWorker },
      steps: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing workers', () => {
    const result = WorkflowSpecSchema.safeParse({ steps: [validStep] });
    expect(result.success).toBe(false);
  });

  test('parses step with needs', () => {
    const result = WorkflowSpecSchema.safeParse({
      workers: { reviewer: validWorker, fixer: validWorker },
      steps: [
        { ...validStep, run: 'reviewer' },
        { run: 'fixer', prompt: 'Fix it', needs: ['reviewer'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('parses step with outputs', () => {
    const result = WorkflowSpecSchema.safeParse({
      workers: { reviewer: validWorker },
      steps: [
        {
          ...validStep,
          outputs: { review: 'file:./review.md' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('parses step with assistant_last_message output', () => {
    const result = WorkflowSpecSchema.safeParse({
      workers: { reviewer: validWorker },
      steps: [
        {
          ...validStep,
          outputs: { summary: 'assistant_last_message' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('rejects output not starting with file: and not assistant_last_message', () => {
    const result = WorkflowSpecSchema.safeParse({
      workers: { reviewer: validWorker },
      steps: [
        {
          ...validStep,
          outputs: { bad: 'stdout' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test('parses step with wait condition', () => {
    const result = WorkflowSpecSchema.safeParse({
      workers: { reviewer: validWorker },
      steps: [
        {
          ...validStep,
          wait: { kind: 'stop', session: 'reviewer', sinceMtime: 0 },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('parses worker with model', () => {
    const result = WorkflowSpecSchema.safeParse({
      workers: { reviewer: { ...validWorker, model: 'opus' } },
      steps: [validStep],
    });
    expect(result.success).toBe(true);
  });
});
