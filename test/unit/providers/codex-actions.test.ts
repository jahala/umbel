import { describe, expect, test } from 'bun:test';
import {
  extractCodexActionsFromContent,
  extractCodexTurnsFromContent,
} from '../../../src/core/providers/codex.ts';

// ---------------------------------------------------------------------------
// Helpers — synthetic Codex rollout JSONL inline
// ---------------------------------------------------------------------------

function sessionMetaLine(id = 'sess'): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo', originator: 'test' },
  });
}

function agentMessageLine(message: string): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message },
  });
}

function taskCompleteLine(): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', usage: { input_tokens: 1, output_tokens: 1 } },
  });
}

function toolCallLine(toolName: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'tool_call', tool_name: toolName, input },
  });
}

function toolResultErrorLine(output: string): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'tool_result', output, is_error: true },
  });
}

// ---------------------------------------------------------------------------
// Reliable surface (final-message + turnCount) — high confidence
// ---------------------------------------------------------------------------

describe('extractCodexActionsFromContent — reliable fields', () => {
  test('empty content → empty manifest', () => {
    const m = extractCodexActionsFromContent('');
    expect(m.toolsUsed).toEqual({});
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
  });

  test('agent_message → finalMessage extracted', () => {
    const jsonl = [sessionMetaLine(), agentMessageLine('hello world'), taskCompleteLine()].join(
      '\n',
    );
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.finalMessage).toBe('hello world');
    expect(m.turnCount).toBe(1);
  });

  test('multi-turn: turnCount equals task_complete count', () => {
    const jsonl = [
      sessionMetaLine(),
      agentMessageLine('a1'),
      taskCompleteLine(),
      agentMessageLine('a2'),
      taskCompleteLine(),
      agentMessageLine('a3'),
      taskCompleteLine(),
    ].join('\n');
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.turnCount).toBe(3);
    expect(m.finalMessage).toBe('a3'); // last agent_message
  });

  test('malformed lines silently skipped', () => {
    const jsonl = [
      sessionMetaLine(),
      'not json',
      agentMessageLine('still works'),
      taskCompleteLine(),
      '{partial',
    ].join('\n');
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.finalMessage).toBe('still works');
    expect(m.turnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defensive surface (tool extraction) — medium confidence
// Shape is inferred; real Codex transcript may differ. Tests document the
// assumed shape; refinement happens when a real transcript is verified.
// ---------------------------------------------------------------------------

describe('extractCodexActionsFromContent — defensive tool extraction', () => {
  test('tool_call with tool_name + input.file_path → filesRead', () => {
    const jsonl = [
      sessionMetaLine(),
      toolCallLine('Read', { file_path: '/repo/foo.ts' }),
      agentMessageLine('done'),
      taskCompleteLine(),
    ].join('\n');
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Read: 1 });
    expect(m.filesRead).toEqual(['/repo/foo.ts']);
  });

  test('multiple Edits + Bash → counts and per-tool fields', () => {
    const jsonl = [
      sessionMetaLine(),
      toolCallLine('Edit', { file_path: '/repo/a.ts' }),
      toolCallLine('Edit', { file_path: '/repo/b.ts' }),
      toolCallLine('Bash', { command: 'bun test' }),
      agentMessageLine('all pass'),
      taskCompleteLine(),
    ].join('\n');
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Edit: 2, Bash: 1 });
    expect(m.filesEdited).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(m.bashCommands).toEqual(['bun test']);
  });

  test('tool_call with `name` field (alternative shape) is also accepted', () => {
    const jsonl = [
      sessionMetaLine(),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'tool_call', name: 'Read', input: { file_path: '/repo/alt.ts' } },
      }),
      agentMessageLine('done'),
      taskCompleteLine(),
    ].join('\n');
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Read: 1 });
    expect(m.filesRead).toEqual(['/repo/alt.ts']);
  });

  test('tool_result with is_error:true → error captured', () => {
    const jsonl = [
      sessionMetaLine(),
      toolCallLine('Edit', { file_path: '/missing.ts' }),
      toolResultErrorLine('File not found'),
      agentMessageLine('failed'),
      taskCompleteLine(),
    ].join('\n');
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.errors).toEqual(['File not found']);
  });

  test('unknown tool just gets counted', () => {
    const jsonl = [
      sessionMetaLine(),
      toolCallLine('SomeFuture', { random_arg: 'value' }),
      agentMessageLine('done'),
      taskCompleteLine(),
    ].join('\n');
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ SomeFuture: 1 });
    expect(m.filesRead).toEqual([]);
  });

  test('text-only session (no tool_call events) → empty tools, valid finalMessage', () => {
    const jsonl = [sessionMetaLine(), agentMessageLine('just chat'), taskCompleteLine()].join('\n');
    const m = extractCodexActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({});
    expect(m.filesRead).toEqual([]);
    expect(m.bashCommands).toEqual([]);
    expect(m.finalMessage).toBe('just chat');
    expect(m.turnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractCodexTurnsFromContent
// ---------------------------------------------------------------------------

describe('extractCodexTurnsFromContent', () => {
  test('empty content → empty array', () => {
    expect(extractCodexTurnsFromContent('')).toEqual([]);
  });

  test('single turn → one entry at index 0', () => {
    const jsonl = [sessionMetaLine(), agentMessageLine('A'), taskCompleteLine()].join('\n');
    expect(extractCodexTurnsFromContent(jsonl)).toEqual([{ index: 0, text: 'A' }]);
  });

  test('three turns → indices 0,1,2 with correct text', () => {
    const jsonl = [
      sessionMetaLine(),
      agentMessageLine('a1'),
      taskCompleteLine(),
      agentMessageLine('a2'),
      taskCompleteLine(),
      agentMessageLine('a3'),
      taskCompleteLine(),
    ].join('\n');
    expect(extractCodexTurnsFromContent(jsonl)).toEqual([
      { index: 0, text: 'a1' },
      { index: 1, text: 'a2' },
      { index: 2, text: 'a3' },
    ]);
  });

  test('task_complete without preceding agent_message → empty text turn', () => {
    const jsonl = [sessionMetaLine(), taskCompleteLine()].join('\n');
    expect(extractCodexTurnsFromContent(jsonl)).toEqual([{ index: 0, text: '' }]);
  });

  test('malformed lines silently skipped', () => {
    const jsonl = [
      sessionMetaLine(),
      'not json',
      agentMessageLine('still works'),
      taskCompleteLine(),
    ].join('\n');
    expect(extractCodexTurnsFromContent(jsonl)).toEqual([{ index: 0, text: 'still works' }]);
  });
});
