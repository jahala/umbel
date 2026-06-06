import { describe, expect, test } from 'bun:test';
import { ProviderUnknownError } from '../../../src/core/errors.ts';
import { GeminiProvider } from '../../../src/core/providers/gemini.ts';
import { getProvider, PROVIDERS } from '../../../src/core/providers/registry.ts';

// ---------------------------------------------------------------------------
// GeminiProvider.buildLaunch
// ---------------------------------------------------------------------------

describe('GeminiProvider.buildLaunch', () => {
  test('returns bin=gemini', () => {
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.bin).toBe('gemini');
  });

  test('args is empty when no model provided', () => {
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.args).toEqual([]);
  });

  test('with model, --model flag is included', () => {
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
      model: 'gemini-2.5-pro',
    });
    expect(spec.args).toContain('--model');
    expect(spec.args).toContain('gemini-2.5-pro');
  });

  test('without model, --model flag is absent', () => {
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.args).not.toContain('--model');
  });

  test('with notifyScriptPath, settings.json registers a Notification hook', () => {
    const notify = '/home/user/.rctrl/hooks/notify.sh';
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
      notifyScriptPath: notify,
    });
    const settingsFile = spec.files.find((f) => f.path.endsWith('.gemini/settings.json'));
    const content = settingsFile?.content ?? '';
    expect(content).toContain('Notification');
    expect(content).toContain(notify);
  });

  test('env is empty object (Gemini needs no extra env vars)', () => {
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.env).toEqual({});
  });

  test('files has exactly one entry at <cwd>/.gemini/settings.json', () => {
    const cwd = '/tmp/test-project';
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd,
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.files).toHaveLength(1);
    expect(spec.files[0]!.path).toBe(`${cwd}/.gemini/settings.json`);
  });

  test('settings.json content is valid JSON', () => {
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(() => JSON.parse(spec.files[0]!.content)).not.toThrow();
  });

  test('settings.json has AfterAgent hook block with hookScriptPath', () => {
    const hookScriptPath = '/home/user/.rctrl/hooks/stop.sh';
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath,
    });
    const settings = JSON.parse(spec.files[0]!.content) as Record<string, unknown>;
    // Top-level hooks key
    expect(settings.hooks).toBeDefined();
    const hooks = settings.hooks as Record<string, unknown>;
    // AfterAgent key (NOT Stop)
    expect(hooks.AfterAgent).toBeDefined();
    expect(Array.isArray(hooks.AfterAgent)).toBe(true);
    // The command must reference our stop.sh
    const content = spec.files[0]!.content;
    expect(content).toContain(hookScriptPath);
    expect(content).toContain('AfterAgent');
  });

  test('settings.json hook uses matcher "*"', () => {
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
    });
    const settings = JSON.parse(spec.files[0]!.content) as {
      hooks: {
        AfterAgent: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string; name: string; timeout: number }>;
        }>;
      };
    };
    const afterAgentGroup = settings.hooks.AfterAgent[0]!;
    expect(afterAgentGroup.matcher).toBe('*');
  });

  test('settings.json hook has type=command, name=rctrl-stop, timeout=60000', () => {
    const spec = GeminiProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp/test-project',
      hookScriptPath: '/tmp/stop.sh',
    });
    const settings = JSON.parse(spec.files[0]!.content) as {
      hooks: {
        AfterAgent: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string; name: string; timeout: number }>;
        }>;
      };
    };
    const hookEntry = settings.hooks.AfterAgent[0]!.hooks[0]!;
    expect(hookEntry.type).toBe('command');
    expect(hookEntry.name).toBe('rctrl-stop');
    expect(hookEntry.timeout).toBe(60000);
  });
});

// ---------------------------------------------------------------------------
// GeminiProvider.stopEventName
// ---------------------------------------------------------------------------

describe('GeminiProvider.stopEventName', () => {
  test('is AfterAgent (not Stop)', () => {
    expect(GeminiProvider.stopEventName).toBe('AfterAgent');
  });
});

// ---------------------------------------------------------------------------
// GeminiProvider.parseTranscript
// ---------------------------------------------------------------------------

// Build a JSONL line for a given record type following the fixture's format.
function makeSessionMetadataLine(sessionId = 'test-session'): string {
  return JSON.stringify({
    type: 'session_metadata',
    sessionId,
    projectHash: 'abc123',
    startTime: new Date().toISOString(),
  });
}

function makeUserLine(text: string, id = 'u-1'): string {
  return JSON.stringify({
    type: 'user',
    id,
    content: [{ text }],
  });
}

function makeGeminiLine(text: string, id = 'g-1'): string {
  return JSON.stringify({
    type: 'gemini',
    id,
    content: [{ text }],
  });
}

function makeMessageUpdateLine(id = 'g-1'): string {
  return JSON.stringify({
    type: 'message_update',
    id,
    tokens: { input: 5, output: 4 },
  });
}

function lines(...entries: string[]): string {
  return `${entries.join('\n')}\n`;
}

describe('GeminiProvider.parseTranscript', () => {
  test('extracts text from a single gemini record', () => {
    const content = lines(
      makeSessionMetadataLine(),
      makeUserLine('hello'),
      makeGeminiLine('Hello back!'),
    );
    expect(GeminiProvider.parseTranscript(content)).toBe('Hello back!');
  });

  test('returns only the last gemini record (ignores earlier turns)', () => {
    const content = lines(
      makeSessionMetadataLine(),
      makeUserLine('first question', 'u-1'),
      makeGeminiLine('First answer.', 'g-1'),
      makeMessageUpdateLine('g-1'),
      makeUserLine('second question', 'u-2'),
      makeGeminiLine('Second answer.', 'g-2'),
      makeMessageUpdateLine('g-2'),
    );
    const result = GeminiProvider.parseTranscript(content);
    expect(result).toBe('Second answer.');
    expect(result).not.toContain('First answer.');
  });

  test('skips trailing message_update records to find the last gemini record', () => {
    // message_update comes after the gemini record — we must look past it
    const content = lines(
      makeSessionMetadataLine(),
      makeUserLine('hello'),
      makeGeminiLine('The answer.'),
      makeMessageUpdateLine('g-1'),
    );
    expect(GeminiProvider.parseTranscript(content)).toBe('The answer.');
  });

  test('joins multiple text parts in content array', () => {
    const line = JSON.stringify({
      type: 'gemini',
      id: 'g-1',
      content: [{ text: 'Part A. ' }, { text: 'Part B.' }],
    });
    expect(GeminiProvider.parseTranscript(`${line}\n`)).toBe('Part A. Part B.');
  });

  test('returns empty string when no gemini record exists', () => {
    const content = lines(makeSessionMetadataLine(), makeUserLine('hello'));
    expect(GeminiProvider.parseTranscript(content)).toBe('');
  });

  test('returns empty string for empty content', () => {
    expect(GeminiProvider.parseTranscript('')).toBe('');
    expect(GeminiProvider.parseTranscript('\n\n')).toBe('');
  });

  test('skips malformed JSON lines silently (pure function, no throw)', () => {
    const content = `not-json\n${makeGeminiLine('Valid response.')}\n`;
    expect(GeminiProvider.parseTranscript(content)).toBe('Valid response.');
  });

  test('returns empty string when gemini record has no content array', () => {
    const line = JSON.stringify({ type: 'gemini', id: 'g-1' });
    expect(GeminiProvider.parseTranscript(`${line}\n`)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// GeminiProvider.anchorStrategy
// ---------------------------------------------------------------------------

describe('GeminiProvider.anchorStrategy', () => {
  test('is undefined (Gemini uses hook-based AfterAgent lifecycle)', () => {
    expect(GeminiProvider.anchorStrategy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('PROVIDERS registry', () => {
  test('gemini is registered', () => {
    expect(PROVIDERS.gemini).toBeDefined();
    expect(PROVIDERS.gemini).toBe(GeminiProvider);
  });
});

describe('getProvider', () => {
  test('returns GeminiProvider for "gemini"', () => {
    const provider = getProvider('gemini');
    expect(provider).toBe(GeminiProvider);
  });

  test('getProvider("gemini") stopEventName is AfterAgent', () => {
    expect(getProvider('gemini').stopEventName).toBe('AfterAgent');
  });

  test('throws ProviderUnknownError for unknown provider', () => {
    expect(() => getProvider('not-a-real-provider')).toThrow(ProviderUnknownError);
  });
});
