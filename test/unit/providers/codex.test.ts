import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CodexProvider } from '../../../src/core/providers/codex.ts';
import { getProvider, PROVIDERS } from '../../../src/core/providers/registry.ts';

// ---------------------------------------------------------------------------
// CodexProvider.buildLaunch
// ---------------------------------------------------------------------------

describe('CodexProvider.buildLaunch', () => {
  test('returns bin=codex', () => {
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.bin).toBe('codex');
  });

  test('without model, --model flag is absent', () => {
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.args).not.toContain('--model');
  });

  test('with model, args contain --model flag and value', () => {
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
      model: 'o4-mini',
    });
    expect(spec.args).toContain('--model');
    expect(spec.args).toContain('o4-mini');
  });

  test('env is empty object (Codex reads its own env; inherited via tmuxEnv)', () => {
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.env).toEqual({});
  });

  test('files has exactly one entry at <cwd>/.codex/hooks.json', () => {
    const cwd = '/home/user/project';
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd,
      hookScriptPath: '/tmp/stop.sh',
    });
    expect(spec.files).toHaveLength(1);
    const file = spec.files[0];
    expect(file).toBeDefined();
    expect(file?.path).toBe(join(cwd, '.codex', 'hooks.json'));
  });

  test('hooks.json content is valid JSON', () => {
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    const file = spec.files[0];
    expect(file).toBeDefined();
    expect(() => JSON.parse(file?.content ?? '')).not.toThrow();
  });

  test('hooks.json contains Stop event with hookScriptPath as command', () => {
    const hookScriptPath = '/home/user/.rctrl/hooks/stop.sh';
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath,
    });
    const file = spec.files[0];
    expect(file).toBeDefined();
    const parsed = JSON.parse(file?.content ?? '{}') as unknown;
    // Structure: { hooks: { Stop: [{ hooks: [{ type: 'command', command: '...' }] }] } }
    expect(parsed).toMatchObject({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: hookScriptPath,
              },
            ],
          },
        ],
      },
    });
  });

  test('hooks.json timeout is in seconds (Codex convention, not ms)', () => {
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    const file = spec.files[0];
    expect(file).toBeDefined();
    const parsed = JSON.parse(file?.content ?? '{}') as {
      hooks: { Stop: Array<{ hooks: Array<{ timeout: number }> }> };
    };
    const stopGroup = parsed.hooks.Stop[0];
    const handler = stopGroup?.hooks[0];
    const timeout = handler?.timeout;
    // A reasonable seconds-based timeout is < 300; ms-based would be >> 1000
    expect(typeof timeout).toBe('number');
    expect(timeout).toBeLessThan(300);
  });

  test('files[0].mode is 0o644', () => {
    const spec = CodexProvider.buildLaunch({
      sessionId: 'test-session',
      cwd: '/tmp',
      hookScriptPath: '/tmp/stop.sh',
    });
    const file = spec.files[0];
    expect(file).toBeDefined();
    expect(file?.mode).toBe(0o644);
  });
});

// ---------------------------------------------------------------------------
// CodexProvider.stopEventName
// ---------------------------------------------------------------------------

describe('CodexProvider.stopEventName', () => {
  test('is Stop', () => {
    expect(CodexProvider.stopEventName).toBe('Stop');
  });
});

// ---------------------------------------------------------------------------
// CodexProvider.parseTranscript
// ---------------------------------------------------------------------------

// Inline fixture JSONL matching the Codex rollout envelope exactly as produced
// by fake-codex.sh.
function makeSessionMeta(sessionId: string): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: '2026-05-22T10:00:00Z',
      cwd: '/tmp',
      originator: 'codex',
      cli_version: '0.1.0',
      model_provider: 'openai',
    },
  });
}

function makeResponseItem(text: string): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
}

function makeUserMsg(text: string): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:01.100Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  });
}

function makeAgentMsg(text: string): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:05.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: text },
  });
}

function makeTaskComplete(): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:05.100Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 },
    },
  });
}

function lines(...entries: string[]): string {
  return `${entries.join('\n')}\n`;
}

describe('CodexProvider.parseTranscript', () => {
  test('extracts agent_message text from a single-turn transcript', () => {
    const content = lines(
      makeSessionMeta('session-1'),
      makeResponseItem('hello'),
      makeUserMsg('hello'),
      makeAgentMsg('Hello! How can I help you?'),
      makeTaskComplete(),
    );
    expect(CodexProvider.parseTranscript(content)).toBe('Hello! How can I help you?');
  });

  test('returns the LAST agent_message (ignores earlier turns)', () => {
    const content = lines(
      makeSessionMeta('session-1'),
      makeResponseItem('first'),
      makeUserMsg('first'),
      makeAgentMsg('First answer.'),
      makeTaskComplete(),
      makeResponseItem('second'),
      makeUserMsg('second'),
      makeAgentMsg('Second answer.'),
      makeTaskComplete(),
    );
    const result = CodexProvider.parseTranscript(content);
    expect(result).toBe('Second answer.');
    expect(result).not.toContain('First answer.');
  });

  test('returns empty string for empty content', () => {
    expect(CodexProvider.parseTranscript('')).toBe('');
  });

  test('returns empty string for whitespace-only content', () => {
    expect(CodexProvider.parseTranscript('\n\n  \n')).toBe('');
  });

  test('returns empty string when no agent_message record exists', () => {
    const content = lines(
      makeSessionMeta('session-1'),
      makeResponseItem('hi'),
      makeUserMsg('hi'),
      makeTaskComplete(),
    );
    expect(CodexProvider.parseTranscript(content)).toBe('');
  });

  test('skips malformed JSON lines silently (pure function, no throw)', () => {
    const content = lines(
      makeSessionMeta('session-1'),
      'not-valid-json',
      makeAgentMsg('Valid response.'),
      makeTaskComplete(),
    );
    expect(CodexProvider.parseTranscript(content)).toBe('Valid response.');
  });

  test('ignores event_msg lines where payload.type is not agent_message', () => {
    const content = lines(makeSessionMeta('session-1'), makeUserMsg('hi'), makeTaskComplete());
    expect(CodexProvider.parseTranscript(content)).toBe('');
  });

  test('ignores non-event_msg records even if payload looks like agent_message', () => {
    // A response_item that happens to have payload.type === 'agent_message' is NOT matched
    const impostor = JSON.stringify({
      timestamp: '2026-05-22T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'agent_message', message: 'should not appear' },
    });
    const content = lines(impostor, makeAgentMsg('Real answer.'));
    expect(CodexProvider.parseTranscript(content)).toBe('Real answer.');
  });
});

// ---------------------------------------------------------------------------
// CodexProvider.anchorStrategy
// ---------------------------------------------------------------------------

describe('CodexProvider.anchorStrategy', () => {
  test('is undefined (Codex uses hook-based lifecycle)', () => {
    expect(CodexProvider.anchorStrategy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('PROVIDERS registry', () => {
  test('codex is registered', () => {
    expect(PROVIDERS.codex).toBeDefined();
    expect(PROVIDERS.codex).toBe(CodexProvider);
  });
});

describe('getProvider', () => {
  test('returns CodexProvider for "codex"', () => {
    const provider = getProvider('codex');
    expect(provider).toBe(CodexProvider);
  });
});
