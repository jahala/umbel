import { describe, expect, test } from 'bun:test';
import {
  extractGeminiActionsFromContent,
  extractGeminiTurnsFromContent,
} from '../../../src/core/providers/gemini.ts';

// ---------------------------------------------------------------------------
// Helpers — synthetic Gemini transcript JSONL inline
// ---------------------------------------------------------------------------

function sessionMetaLine(): string {
  return JSON.stringify({
    type: 'session_metadata',
    sessionId: 'sess',
    projectHash: 'h',
    startTime: '2026-01-01T00:00:00Z',
  });
}

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', id: 'u', content: [{ text }] });
}

function geminiTextLine(text: string): string {
  return JSON.stringify({ type: 'gemini', id: 'g', content: [{ text }] });
}

function geminiWithToolBlock(text: string, toolBlock: Record<string, unknown>): string {
  return JSON.stringify({ type: 'gemini', id: 'g', content: [{ text }, toolBlock] });
}

// ---------------------------------------------------------------------------
// Reliable surface (final-message + turnCount) — high confidence
// ---------------------------------------------------------------------------

describe('extractGeminiActionsFromContent — reliable fields', () => {
  test('empty content → empty manifest', () => {
    const m = extractGeminiActionsFromContent('');
    expect(m.toolsUsed).toEqual({});
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
  });

  test('single gemini record → finalMessage + turnCount=1', () => {
    const jsonl = [sessionMetaLine(), userLine('q'), geminiTextLine('A')].join('\n');
    const m = extractGeminiActionsFromContent(jsonl);
    expect(m.finalMessage).toBe('A');
    expect(m.turnCount).toBe(1);
  });

  test('three turns → turnCount=3, finalMessage from last', () => {
    const jsonl = [
      sessionMetaLine(),
      userLine('q1'),
      geminiTextLine('a1'),
      userLine('q2'),
      geminiTextLine('a2'),
      userLine('q3'),
      geminiTextLine('a3'),
    ].join('\n');
    const m = extractGeminiActionsFromContent(jsonl);
    expect(m.turnCount).toBe(3);
    expect(m.finalMessage).toBe('a3');
  });

  test('malformed lines silently skipped', () => {
    const jsonl = [sessionMetaLine(), 'not json', geminiTextLine('still works'), '{partial'].join(
      '\n',
    );
    const m = extractGeminiActionsFromContent(jsonl);
    expect(m.finalMessage).toBe('still works');
    expect(m.turnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defensive surface (tool extraction) — medium confidence
// ---------------------------------------------------------------------------

describe('extractGeminiActionsFromContent — defensive tool extraction', () => {
  test('function_call block within gemini.content → tool counted', () => {
    const jsonl = [
      sessionMetaLine(),
      userLine('q'),
      geminiWithToolBlock('using tool', { name: 'Read', args: { file_path: '/repo/foo.ts' } }),
    ].join('\n');
    const m = extractGeminiActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Read: 1 });
    expect(m.filesRead).toEqual(['/repo/foo.ts']);
  });

  test('top-level function_call record → tool counted', () => {
    const jsonl = [
      sessionMetaLine(),
      userLine('q'),
      JSON.stringify({ type: 'function_call', name: 'Bash', args: { command: 'ls' } }),
      geminiTextLine('done'),
    ].join('\n');
    const m = extractGeminiActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Bash: 1 });
    expect(m.bashCommands).toEqual(['ls']);
  });

  test('nested function_call object inside content block', () => {
    const jsonl = [
      sessionMetaLine(),
      userLine('q'),
      geminiWithToolBlock('using', {
        function_call: { name: 'Edit', args: { file_path: '/repo/a.ts' } },
      }),
    ].join('\n');
    const m = extractGeminiActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Edit: 1 });
    expect(m.filesEdited).toEqual(['/repo/a.ts']);
  });

  test('function_response with is_error:true → error captured', () => {
    const jsonl = [
      sessionMetaLine(),
      userLine('q'),
      JSON.stringify({ type: 'function_response', response: 'tool failed', is_error: true }),
      geminiTextLine('done'),
    ].join('\n');
    const m = extractGeminiActionsFromContent(jsonl);
    expect(m.errors).toEqual(['tool failed']);
  });

  test('text-only session → empty tools, valid finalMessage', () => {
    const jsonl = [sessionMetaLine(), userLine('hi'), geminiTextLine('hello')].join('\n');
    const m = extractGeminiActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({});
    expect(m.filesRead).toEqual([]);
    expect(m.finalMessage).toBe('hello');
    expect(m.turnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractGeminiTurnsFromContent
// ---------------------------------------------------------------------------

describe('extractGeminiTurnsFromContent', () => {
  test('empty content → empty array', () => {
    expect(extractGeminiTurnsFromContent('')).toEqual([]);
  });

  test('single gemini record → one entry at index 0', () => {
    const jsonl = [sessionMetaLine(), userLine('q'), geminiTextLine('A')].join('\n');
    expect(extractGeminiTurnsFromContent(jsonl)).toEqual([{ index: 0, text: 'A' }]);
  });

  test('three turns → indices 0,1,2 in order', () => {
    const jsonl = [
      sessionMetaLine(),
      userLine('q1'),
      geminiTextLine('a1'),
      userLine('q2'),
      geminiTextLine('a2'),
      userLine('q3'),
      geminiTextLine('a3'),
    ].join('\n');
    expect(extractGeminiTurnsFromContent(jsonl)).toEqual([
      { index: 0, text: 'a1' },
      { index: 1, text: 'a2' },
      { index: 2, text: 'a3' },
    ]);
  });

  test('gemini record with no text blocks → empty-text turn', () => {
    const jsonl = [
      sessionMetaLine(),
      userLine('q'),
      JSON.stringify({ type: 'gemini', id: 'g', content: [] }),
    ].join('\n');
    expect(extractGeminiTurnsFromContent(jsonl)).toEqual([{ index: 0, text: '' }]);
  });

  test('multiple text blocks in one gemini record are concatenated', () => {
    const jsonl = [
      sessionMetaLine(),
      userLine('q'),
      JSON.stringify({
        type: 'gemini',
        id: 'g',
        content: [{ text: 'part 1 ' }, { text: 'part 2' }],
      }),
    ].join('\n');
    expect(extractGeminiTurnsFromContent(jsonl)).toEqual([{ index: 0, text: 'part 1 part 2' }]);
  });

  test('malformed lines silently skipped', () => {
    const jsonl = [sessionMetaLine(), 'not json', geminiTextLine('still works'), '{partial'].join(
      '\n',
    );
    expect(extractGeminiTurnsFromContent(jsonl)).toEqual([{ index: 0, text: 'still works' }]);
  });
});
