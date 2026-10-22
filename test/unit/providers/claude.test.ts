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

// ---------------------------------------------------------------------------
// ClaudeProvider.extractUsage — the newest completed turn's token usage
//
// Claude writes one entry per content block and copies the whole message's
// usage onto every one of them, so a message id must count once. A turn spans
// several API answers around tool calls, so those sum. input_tokens excludes
// cached input; cache_creation_input_tokens is the write side.
// ---------------------------------------------------------------------------

interface ClaudeUsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function makeUsageAssistantLine(opts: {
  id: string;
  text?: string;
  blockType?: 'text' | 'tool_use';
  stopReason: string | null;
  usage?: ClaudeUsageFields;
  model?: string;
}): string {
  const block =
    opts.blockType === 'tool_use'
      ? { type: 'tool_use', id: 't1', name: 'Read', input: {} }
      : { type: 'text', text: opts.text ?? '' };
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: opts.id,
      role: 'assistant',
      model: opts.model ?? 'claude-test',
      content: [block],
      ...(opts.stopReason !== null ? { stop_reason: opts.stopReason } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    },
  });
}

function makeToolResultLine(): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    },
  });
}

function claudeUsage(content: string) {
  if (ClaudeProvider.extractUsage === undefined) {
    throw new Error('claude has no extractUsage');
  }
  return ClaudeProvider.extractUsage(content);
}

describe('ClaudeProvider.extractUsage', () => {
  test('counts a message copied onto several block entries once', () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
    };
    const content = lines(
      makeUserLine('q'),
      makeUsageAssistantLine({ id: 'm1', text: '', stopReason: 'end_turn', usage }),
      makeUsageAssistantLine({ id: 'm1', text: 'answer', stopReason: 'end_turn', usage }),
    );
    expect(claudeUsage(content)).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
      model: 'claude-test',
    });
  });

  test('sums every API answer in a multi-answer turn, skipping tool results', () => {
    const content = lines(
      makeUserLine('q'),
      makeUsageAssistantLine({
        id: 'm1',
        blockType: 'tool_use',
        stopReason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      makeToolResultLine(),
      makeUsageAssistantLine({
        id: 'm2',
        text: 'done',
        stopReason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    expect(claudeUsage(content)).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      model: 'claude-test',
    });
  });

  test('returns the newest completed turn only', () => {
    const content = lines(
      makeUserLine('first'),
      makeUsageAssistantLine({
        id: 'm1',
        text: 'first answer',
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      makeUserLine('second'),
      makeUsageAssistantLine({
        id: 'm2',
        text: 'second answer',
        stopReason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    expect(claudeUsage(content)).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      model: 'claude-test',
    });
  });

  test('an open turn does not borrow its own usage; the previous completed turn wins', () => {
    const content = lines(
      makeUserLine('first'),
      makeUsageAssistantLine({
        id: 'm1',
        text: 'first answer',
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      makeUserLine('second'),
      makeUsageAssistantLine({
        id: 'm2',
        text: 'still writing',
        stopReason: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
    expect(claudeUsage(content)).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      model: 'claude-test',
    });
  });

  test('returns undefined when the completed turn recorded no usage', () => {
    const content = lines(makeUserLine('q'), makeAssistantLine('answer', 'end_turn'));
    expect(claudeUsage(content)).toBeUndefined();
  });

  test('returns undefined when no turn has completed', () => {
    const content = lines(makeUserLine('q'), makeAssistantLine('partial', null));
    expect(claudeUsage(content)).toBeUndefined();
  });

  test('malformed lines are skipped, not fatal', () => {
    const content = [
      'not json',
      makeUserLine('q'),
      '{partial',
      makeUsageAssistantLine({
        id: 'm1',
        text: 'answer',
        stopReason: 'end_turn',
        usage: { input_tokens: 9 },
      }),
    ].join('\n');
    expect(claudeUsage(content)).toEqual({ inputTokens: 9, model: 'claude-test' });
  });
});

// Claude Code 2.1.306 writes api-request-blob entries: copies of the request it
// sends, with message.role "user" and plain text content, between a tool result
// and the next answer. Shape taken from a real DeepSeek Flash turn that ran one
// tool: a copy read as a new prompt split the turn and dropped the first
// answer's tokens.
describe('claude transcript with api-request-blob copies', () => {
  const turn = [
    { type: 'user', message: { role: 'user', content: 'Run date, then reply done.' } },
    {
      type: 'assistant',
      message: {
        id: 'answer-1',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [{ type: 'thinking', thinking: '' }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 25431, output_tokens: 58, cache_read_input_tokens: 0 },
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'answer-1',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'date' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 25431, output_tokens: 58, cache_read_input_tokens: 0 },
      },
    },
    {
      type: 'api-request-blob',
      message: { role: 'user', content: [{ type: 'text', text: 'Run date, then reply done.' }] },
    },
    {
      type: 'api-request-blob',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Wed' }],
      },
    },
    { type: 'api-request', timestamp: '2026-10-22T16:00:00.000Z' },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Wed' }],
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'answer-2',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 376, output_tokens: 2, cache_read_input_tokens: 25472 },
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');

  test('a turn is summed across both answers', () => {
    expect(ClaudeProvider.extractUsage?.(turn)).toEqual({
      inputTokens: 25807,
      outputTokens: 60,
      cacheReadTokens: 25472,
      model: 'deepseek-flash',
    });
  });

  test('the copies are not turns of their own', () => {
    expect(ClaudeProvider.extractTurns?.(turn).length).toBe(1);
    expect(ClaudeProvider.parseTranscript(turn)).toBe('done');
  });
});
