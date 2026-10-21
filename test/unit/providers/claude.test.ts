import { describe, expect, test } from 'bun:test';
import { ProviderUnknownError } from '../../../src/core/errors.ts';
import { ClaudeProvider } from '../../../src/core/providers/claude.ts';
import { getProvider, PROVIDERS } from '../../../src/core/providers/registry.ts';

// ---------------------------------------------------------------------------
// ClaudeProvider.buildLaunch
// ---------------------------------------------------------------------------

describe('ClaudeProvider.buildLaunch', () => {
  test('returns bin=claude', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.bin).toBe('claude');
  });

  test('args contain --settings flag', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.args).toContain('--settings');
  });

  test('--settings value is valid JSON', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    const settingsIdx = spec.args.indexOf('--settings');
    const settingsJson = spec.args[settingsIdx + 1];
    expect(settingsJson).toBeDefined();
    expect(() => JSON.parse(settingsJson as string)).not.toThrow();
  });

  test('settings JSON contains Stop hook with hookScriptPath', () => {
    const hookScriptPath = '/home/user/.umbel/hooks/stop.sh';
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath,
    });
    const settingsIdx = spec.args.indexOf('--settings');
    const settingsJson = spec.args[settingsIdx + 1] ?? '';
    expect(settingsJson).toContain(hookScriptPath);
    expect(settingsJson).toContain('Stop');
  });

  test('with model, --model flag is included', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
      model: 'sonnet',
    });
    expect(spec.args).toContain('--model');
    expect(spec.args).toContain('sonnet');
  });

  test('without model, --model flag is absent', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.args).not.toContain('--model');
  });

  test('with allowedTools, settings JSON contains permissions', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
      allowedTools: 'Read,Write,Bash',
    });
    const settingsIdx = spec.args.indexOf('--settings');
    const settingsJson = spec.args[settingsIdx + 1] ?? '';
    expect(settingsJson).toContain('Read');
    expect(settingsJson).toContain('Write');
    expect(settingsJson).toContain('Bash');
  });

  test('files is empty array (Claude uses inline --settings)', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.files).toEqual([]);
  });

  test('env is empty object (Claude needs no extra env vars)', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.env).toEqual({});
  });

  test('with notifyScriptPath, settings JSON registers a Notification hook', () => {
    const notify = '/home/user/.umbel/hooks/notify.sh';
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
      notifyScriptPath: notify,
    });
    const settingsIdx = spec.args.indexOf('--settings');
    const settingsJson = spec.args[settingsIdx + 1] ?? '';
    expect(settingsJson).toContain('Notification');
    expect(settingsJson).toContain(notify);
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider.reconcileEnv — drop a conflicting inherited ANTHROPIC_API_KEY
// ---------------------------------------------------------------------------

describe('ClaudeProvider.reconcileEnv', () => {
  test('drops ANTHROPIC_API_KEY when ANTHROPIC_AUTH_TOKEN is set', () => {
    const reconcile = ClaudeProvider.reconcileEnv;
    expect(reconcile).toBeDefined();
    const out = reconcile?.({
      ANTHROPIC_AUTH_TOKEN: 'bearer-xyz',
      ANTHROPIC_API_KEY: 'sk-should-be-dropped',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      PATH: '/usr/bin',
    });
    expect(out?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out?.ANTHROPIC_AUTH_TOKEN).toBe('bearer-xyz');
    expect(out?.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(out?.PATH).toBe('/usr/bin');
  });

  test('keeps ANTHROPIC_API_KEY when no AUTH_TOKEN (normal API worker untouched)', () => {
    const reconcile = ClaudeProvider.reconcileEnv;
    expect(reconcile).toBeDefined();
    const out = reconcile?.({ ANTHROPIC_API_KEY: 'sk-legit', PATH: '/usr/bin' });
    expect(out?.ANTHROPIC_API_KEY).toBe('sk-legit');
  });

  test('is a no-op when neither credential var is set', () => {
    const reconcile = ClaudeProvider.reconcileEnv;
    expect(reconcile).toBeDefined();
    const input = { PATH: '/usr/bin', HOME: '/home/x' };
    expect(reconcile?.(input)).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider.stopEventName
// ---------------------------------------------------------------------------

describe('ClaudeProvider.stopEventName', () => {
  test('is Stop', () => {
    expect(ClaudeProvider.stopEventName).toBe('Stop');
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider.parseTranscript
// ---------------------------------------------------------------------------

// Fixture helpers (same shapes as jsonl.test.ts)
function makeAssistantLine(text: string, stopReason: string | null = null): string {
  return JSON.stringify({
    parentUuid: 'abc',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
    },
    uuid: 'uuid1',
    timestamp: new Date().toISOString(),
  });
}

function makeUserLine(text: string): string {
  return JSON.stringify({
    parentUuid: null,
    type: 'human',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    uuid: 'uuid0',
    timestamp: new Date().toISOString(),
  });
}

function lines(...entries: string[]): string {
  return `${entries.join('\n')}\n`;
}

describe('ClaudeProvider.parseTranscript', () => {
  test('extracts text from simple assistant entry', () => {
    const content = lines(makeUserLine('hi'), makeAssistantLine('Hello there!', 'end_turn'));
    expect(ClaudeProvider.parseTranscript(content)).toBe('Hello there!');
  });

  test('joins consecutive assistant entries (streaming)', () => {
    const content = lines(
      makeUserLine('question'),
      makeAssistantLine('Part one. ', null),
      makeAssistantLine('Part two. ', null),
      makeAssistantLine('Part three.', 'end_turn'),
    );
    const result = ClaudeProvider.parseTranscript(content);
    expect(result).toContain('Part one.');
    expect(result).toContain('Part two.');
    expect(result).toContain('Part three.');
  });

  test('returns only the last turn (ignores earlier assistant turns)', () => {
    const content = lines(
      makeUserLine('first question'),
      makeAssistantLine('First answer.', 'end_turn'),
      makeUserLine('second question'),
      makeAssistantLine('Second answer.', 'end_turn'),
    );
    const result = ClaudeProvider.parseTranscript(content);
    expect(result).toBe('Second answer.');
    expect(result).not.toContain('First answer.');
  });

  test('handles content as plain string (shape B)', () => {
    const line = JSON.stringify({
      role: 'assistant',
      content: 'Plain string.',
      stop_reason: 'end_turn',
    });
    expect(ClaudeProvider.parseTranscript(`${line}\n`)).toBe('Plain string.');
  });

  test('handles empty content gracefully', () => {
    expect(ClaudeProvider.parseTranscript('')).toBe('');
    expect(ClaudeProvider.parseTranscript('\n\n')).toBe('');
  });

  test('skips malformed JSON lines silently (pure function, no throw)', () => {
    const content = `not-json\n${makeAssistantLine('Valid.', 'end_turn')}\n`;
    // Malformed line is silently skipped; valid assistant entry is found
    expect(ClaudeProvider.parseTranscript(content)).toBe('Valid.');
  });

  test('ignores metadata entries appended after assistant response', () => {
    const systemLine = JSON.stringify({ type: 'system', content: 'meta' });
    const content = lines(
      makeUserLine('q'),
      makeAssistantLine('Answer.', 'end_turn'),
      systemLine, // metadata after the turn — must be ignored
    );
    expect(ClaudeProvider.parseTranscript(content)).toBe('Answer.');
  });

  test('joins only text blocks from content array (ignores tool_use)', () => {
    const line = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Part A. ' },
        { type: 'tool_use', id: 'tool1', name: 'Read', input: {} },
        { type: 'text', text: 'Part B.' },
      ],
      stop_reason: 'end_turn',
    });
    expect(ClaudeProvider.parseTranscript(`${line}\n`)).toBe('Part A. Part B.');
  });
});

// ---------------------------------------------------------------------------
// ClaudeProvider.anchorStrategy
// ---------------------------------------------------------------------------

describe('ClaudeProvider.anchorStrategy', () => {
  test('is undefined (Claude uses hook-based lifecycle)', () => {
    expect(ClaudeProvider.anchorStrategy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('PROVIDERS registry', () => {
  test('claude is registered', () => {
    expect(PROVIDERS.claude).toBeDefined();
    expect(PROVIDERS.claude).toBe(ClaudeProvider);
  });
});

describe('getProvider', () => {
  test('returns ClaudeProvider for "claude"', () => {
    const provider = getProvider('claude');
    expect(provider).toBe(ClaudeProvider);
  });

  test('throws ProviderUnknownError for unknown provider', () => {
    expect(() => getProvider('unknown-provider')).toThrow(ProviderUnknownError);
  });

  test('ProviderUnknownError message contains the unknown name', () => {
    let err: unknown;
    try {
      getProvider('my-missing-provider');
    } catch (e) {
      err = e;
    }
    expect(err instanceof ProviderUnknownError).toBe(true);
    expect((err as ProviderUnknownError).providerName).toBe('my-missing-provider');
  });
});

describe('ClaudeProvider.subagentTranscriptDir', () => {
  test('is the <session>/subagents directory beside the transcript', () => {
    expect(ClaudeProvider.subagentTranscriptDir?.('/p/-tmp/abc-123.jsonl')).toBe(
      '/p/-tmp/abc-123/subagents',
    );
  });
});

// ---------------------------------------------------------------------------
// requestInFlight: is the worker waiting on the model, or merely silent?
//
// Shapes are trimmed from a real Claude Code 2.1.306 transcript: an
// api-request entry goes out with the request, the answer follows as assistant
// entries, and metadata lines with no timestamp may sit in between.
// api-request-blob entries hold a copy of a message's content, not a new
// answer, and must not close the request.
// ---------------------------------------------------------------------------

const REQUEST_AT = '2026-10-21T19:27:24.799Z';
const ANSWER_AT = '2026-10-21T19:27:29.591Z';

const promptLine = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
  timestamp: '2026-10-21T19:27:20.000Z',
});

const toolResultLine = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  timestamp: '2026-10-21T19:27:24.787Z',
});

const requestLine = JSON.stringify({
  type: 'api-request',
  timestamp: REQUEST_AT,
  querySource: 'repl_main_thread',
  params: { model: 'deepseek-flash' },
});

const answerLine = JSON.stringify({
  type: 'assistant',
  timestamp: ANSWER_AT,
  uuid: 'a-1',
  message: {
    id: 'm-1',
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'done' }],
    stop_reason: 'end_turn',
  },
});

const blobLine = JSON.stringify({
  type: 'api-request-blob',
  hash: 'e78f9914',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'done' }],
    stop_reason: 'end_turn',
  },
});

const metadataLine = JSON.stringify({ type: 'last-prompt', lastPrompt: 'go' });

describe('ClaudeProvider.requestInFlight', () => {
  const inFlight = (lines: string[]): string | undefined => {
    if (ClaudeProvider.requestInFlight === undefined) {
      throw new Error('claude has no requestInFlight');
    }
    return ClaudeProvider.requestInFlight(lines.join('\n'));
  };

  test("a request whose answer has not landed is in flight, dated by the request's entry", () => {
    expect(inFlight([promptLine, requestLine, metadataLine])).toBe(REQUEST_AT);
  });

  test('the answer landing clears it', () => {
    expect(inFlight([promptLine, requestLine, metadataLine, answerLine])).toBeUndefined();
  });

  test("a previous turn's answer does not clear a newer request", () => {
    expect(inFlight([answerLine, toolResultLine, requestLine])).toBe(REQUEST_AT);
  });

  test('a tool result written after the request keeps it in flight', () => {
    expect(inFlight([answerLine, requestLine, toolResultLine, metadataLine])).toBe(REQUEST_AT);
  });

  test("a request blob's assistant copy is not an answer", () => {
    expect(inFlight([requestLine, blobLine])).toBe(REQUEST_AT);
  });

  test('a transcript with no request is not in flight', () => {
    expect(inFlight([promptLine, answerLine])).toBeUndefined();
  });

  test('malformed lines are skipped, not fatal', () => {
    expect(inFlight(['not json', requestLine, '{"type":'])).toBe(REQUEST_AT);
  });

  test('an empty transcript is not in flight', () => {
    expect(inFlight([])).toBeUndefined();
  });
});
