/**
 * Unit tests for src/faces/verbs.ts
 *
 * Covers:
 * - parseDuration: valid cases (ms, s, m, h, fractional) and invalid cases (throws UmbelUsageError with input in message)
 * - VerbSchemas: each verb parses a valid input AND rejects an invalid one with a checked zod issue
 */
import { describe, expect, test } from 'bun:test';
import { UmbelUsageError } from '../../src/core/errors.ts';
import { parseDuration, VerbSchemas } from '../../src/faces/verbs.ts';

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration — valid', () => {
  test('500ms → 500', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  test('30s → 30000', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  test('5m → 300000', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  test('1h → 3600000', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  test('1.5h → 5400000', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  test('0ms → 0', () => {
    expect(parseDuration('0ms')).toBe(0);
  });

  test('1s → 1000', () => {
    expect(parseDuration('1s')).toBe(1000);
  });
});

describe('parseDuration — invalid (throws UmbelUsageError)', () => {
  function expectUsageError(input: string): void {
    let caught: unknown;
    try {
      parseDuration(input);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof UmbelUsageError).toBe(true);
    // The error message must include the bad input so users can diagnose it
    expect((caught as UmbelUsageError).message).toContain(input);
  }

  test("'5' — bare number, no unit", () => expectUsageError('5'));
  test("'abc' — no digits", () => expectUsageError('abc'));
  test("'' — empty string", () => expectUsageError(''));
  test("'5x' — unknown unit", () => expectUsageError('5x'));
  test("'-3s' — negative", () => expectUsageError('-3s'));
  test("'1 s' — space before unit", () => expectUsageError('1 s'));
  test("'ms' — unit with no value", () => expectUsageError('ms'));
});

// ---------------------------------------------------------------------------
// VerbSchemas — representative parse + reject per verb
// ---------------------------------------------------------------------------

describe('VerbSchemas.spawn', () => {
  test('parses valid input with all optional fields', () => {
    const result = VerbSchemas.spawn.safeParse({
      name: 'my-session',
      cwd: '/tmp',
      model: 'sonnet',
      allowedTools: 'Read,Write',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('my-session');
      expect(result.data.cwd).toBe('/tmp');
      expect(result.data.model).toBe('sonnet');
    }
  });

  test('applies default cwd=. when omitted', () => {
    const result = VerbSchemas.spawn.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe('.');
    }
  });

  test('accepts any string model (provider-agnostic)', () => {
    // model is now z.string() — each provider validates its own model names.
    const result = VerbSchemas.spawn.safeParse({ model: 'turbo' });
    expect(result.success).toBe(true);
  });
});

describe('VerbSchemas.send', () => {
  test('parses valid send input', () => {
    const result = VerbSchemas.send.safeParse({ name: 'foo', prompt: 'hello' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('foo');
      expect(result.data.prompt).toBe('hello');
    }
  });

  test('rejects missing prompt', () => {
    const result = VerbSchemas.send.safeParse({ name: 'foo' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('prompt');
    }
  });

  test('rejects missing name', () => {
    const result = VerbSchemas.send.safeParse({ prompt: 'hello' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('name');
    }
  });
});

describe('VerbSchemas.wait', () => {
  test('parses valid wait with defaults', () => {
    const result = VerbSchemas.wait.safeParse({ name: 'foo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.until).toBe('stop');
    }
  });

  test('parses wait with until=file', () => {
    const result = VerbSchemas.wait.safeParse({ name: 'foo', until: 'file', file: '/tmp/done' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.until).toBe('file');
      expect(result.data.file).toBe('/tmp/done');
    }
  });

  test('rejects invalid until value', () => {
    const result = VerbSchemas.wait.safeParse({ name: 'foo', until: 'custom' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('until');
    }
  });

  test('rejects missing name', () => {
    const result = VerbSchemas.wait.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('name');
    }
  });
});

describe('VerbSchemas.status', () => {
  test('parses with no name (list all)', () => {
    const result = VerbSchemas.status.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBeUndefined();
    }
  });

  test('parses with a name', () => {
    const result = VerbSchemas.status.safeParse({ name: 'bar' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('bar');
    }
  });

  test('rejects non-string name', () => {
    const result = VerbSchemas.status.safeParse({ name: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('name');
      expect(result.error.issues[0]?.code).toBe('invalid_type');
    }
  });
});

describe('VerbSchemas.ls', () => {
  test('parses empty object', () => {
    const result = VerbSchemas.ls.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('VerbSchemas.kill', () => {
  test('parses with required name, keepState defaults to false', () => {
    const result = VerbSchemas.kill.safeParse({ name: 'foo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('foo');
      expect(result.data.keepState).toBe(false);
    }
  });

  test('parses with keepState=true', () => {
    const result = VerbSchemas.kill.safeParse({ name: 'foo', keepState: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keepState).toBe(true);
    }
  });

  test('rejects missing name', () => {
    const result = VerbSchemas.kill.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('name');
    }
  });
});

describe('VerbSchemas.read', () => {
  test('parses with required name', () => {
    const result = VerbSchemas.read.safeParse({ name: 'sess' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('sess');
    }
  });

  test('rejects missing name', () => {
    const result = VerbSchemas.read.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('invalid_type');
    }
  });
});

describe('VerbSchemas.capture', () => {
  test('parses with required name, lines defaults to 100', () => {
    const result = VerbSchemas.capture.safeParse({ name: 'foo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lines).toBe(100);
    }
  });

  test('parses with custom lines', () => {
    const result = VerbSchemas.capture.safeParse({ name: 'foo', lines: 50 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lines).toBe(50);
    }
  });

  test('rejects non-positive lines', () => {
    const result = VerbSchemas.capture.safeParse({ name: 'foo', lines: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('lines');
    }
  });

  test('rejects non-integer lines', () => {
    const result = VerbSchemas.capture.safeParse({ name: 'foo', lines: 1.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('lines');
    }
  });
});

describe('VerbSchemas.logs', () => {
  test('parses with required name, follow defaults to false', () => {
    const result = VerbSchemas.logs.safeParse({ name: 'foo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.follow).toBe(false);
    }
  });

  test('rejects missing name', () => {
    const result = VerbSchemas.logs.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('VerbSchemas.run', () => {
  test('parses with required file', () => {
    const result = VerbSchemas.run.safeParse({ file: 'workflow.yaml' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file).toBe('workflow.yaml');
    }
  });

  test('rejects missing file', () => {
    const result = VerbSchemas.run.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('file');
    }
  });
});

describe('VerbSchemas.mcp', () => {
  test('parses empty object', () => {
    const result = VerbSchemas.mcp.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('VerbSchemas.attach', () => {
  test('parses with required name', () => {
    const result = VerbSchemas.attach.safeParse({ name: 'foo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('foo');
    }
  });

  test('rejects missing name', () => {
    const result = VerbSchemas.attach.safeParse({});
    expect(result.success).toBe(false);
  });
});
