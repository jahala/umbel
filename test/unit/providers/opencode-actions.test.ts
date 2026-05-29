import { describe, expect, test } from 'bun:test';
import {
  extractOpencodeActionsFromContent,
  extractOpencodeTurnsFromContent,
} from '../../../src/core/providers/opencode.ts';

// ---------------------------------------------------------------------------
// Helpers — synthetic opencode export JSON (as produced by `opencode export`)
// ---------------------------------------------------------------------------
//
// Real export shape (§4 of docs/research/opencode-surface.md):
//   { info: {...}, messages: [{ info: { role }, parts: [{ type, text? }] }] }
//
// Part types observed: step-start, reasoning, text, step-finish.
// Tool-call part shapes are NOT documented — we infer a plausible shape and
// document it here so tests double as a spec for the assumed format.
//
// ASSUMED tool-call part shape (unverified against a real tool-using transcript):
//   { type: 'tool-call', toolName: string, args: { file_path?: string, command?: string, ... } }
//   or
//   { type: 'tool-call', toolName: string, input: { file_path?: string, ... } }
// ASSUMED tool-result-error part shape:
//   { type: 'tool-result', toolCallId: string, isError: true, content: string }
//
// These shapes are chosen by analogy with Codex/Gemini extractors which accept
// both `args`/`input` and `tool_name`/`name` variants. If the real opencode
// transcript differs, this comment + the tests must be updated.

function makeExportJson(
  messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
): string {
  return JSON.stringify({
    info: {
      id: 'ses_abc123',
      slug: 'test-session',
      projectID: 'global',
      directory: '/tmp/test',
      title: 'Test session',
      model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' },
      version: '1.15.12',
    },
    messages: messages.map((m) => ({
      info: { role: m.role },
      parts: m.parts,
    })),
  });
}

function textPart(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

function stepStartPart(): Record<string, unknown> {
  return { type: 'step-start' };
}

function reasoningPart(text: string): Record<string, unknown> {
  return { type: 'reasoning', text };
}

function stepFinishPart(): Record<string, unknown> {
  return { type: 'step-finish', reason: 'stop' };
}

// Inferred tool-call part shape — see comment at top of file.
function toolCallPart(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: 'tool-call', toolName, args };
}

// Inferred tool-result error part shape — see comment at top of file.
function toolResultErrorPart(content: string): Record<string, unknown> {
  return { type: 'tool-result', isError: true, content };
}

// ---------------------------------------------------------------------------
// extractOpencodeTurnsFromContent
// ---------------------------------------------------------------------------

describe('extractOpencodeTurnsFromContent', () => {
  test('empty string → empty array (no throw)', () => {
    expect(extractOpencodeTurnsFromContent('')).toEqual([]);
  });

  test('whitespace-only → empty array', () => {
    expect(extractOpencodeTurnsFromContent('   \n  ')).toEqual([]);
  });

  test('malformed JSON → empty array', () => {
    expect(extractOpencodeTurnsFromContent('not valid json')).toEqual([]);
  });

  test('empty messages array → empty array', () => {
    const content = makeExportJson([]);
    expect(extractOpencodeTurnsFromContent(content)).toEqual([]);
  });

  test('no assistant messages → empty array', () => {
    const content = makeExportJson([{ role: 'user', parts: [textPart('hi')] }]);
    expect(extractOpencodeTurnsFromContent(content)).toEqual([]);
  });

  test('single assistant message → one turn at index 0', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('say hello')] },
      { role: 'assistant', parts: [stepStartPart(), textPart('hello'), stepFinishPart()] },
    ]);
    expect(extractOpencodeTurnsFromContent(content)).toEqual([{ index: 0, text: 'hello' }]);
  });

  test('multiple text parts in one assistant message are concatenated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('hi')] },
      { role: 'assistant', parts: [textPart('part one '), textPart('part two')] },
    ]);
    expect(extractOpencodeTurnsFromContent(content)).toEqual([
      { index: 0, text: 'part one part two' },
    ]);
  });

  test('three assistant messages → indices 0,1,2 with correct text', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q1')] },
      { role: 'assistant', parts: [textPart('a1')] },
      { role: 'user', parts: [textPart('q2')] },
      { role: 'assistant', parts: [textPart('a2')] },
      { role: 'user', parts: [textPart('q3')] },
      { role: 'assistant', parts: [textPart('a3')] },
    ]);
    expect(extractOpencodeTurnsFromContent(content)).toEqual([
      { index: 0, text: 'a1' },
      { index: 1, text: 'a2' },
      { index: 2, text: 'a3' },
    ]);
  });

  test('user and system messages are excluded; only assistant messages become turns', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('question')] },
      { role: 'system', parts: [textPart('system instruction')] },
      { role: 'assistant', parts: [textPart('answer')] },
    ]);
    const turns = extractOpencodeTurnsFromContent(content);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ index: 0, text: 'answer' });
  });

  test('non-text parts (step-start, reasoning, step-finish) are ignored in text concat', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [
          stepStartPart(),
          reasoningPart('thinking...'),
          textPart('OPENCODE_OK'),
          stepFinishPart(),
        ],
      },
    ]);
    expect(extractOpencodeTurnsFromContent(content)).toEqual([{ index: 0, text: 'OPENCODE_OK' }]);
  });

  test('assistant message with no text parts → empty-text turn', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      { role: 'assistant', parts: [stepStartPart(), stepFinishPart()] },
    ]);
    expect(extractOpencodeTurnsFromContent(content)).toEqual([{ index: 0, text: '' }]);
  });

  test('trailing non-assistant message does not affect turn extraction', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      { role: 'assistant', parts: [textPart('OPENCODE_OK')] },
      { role: 'system', parts: [textPart('metadata')] },
    ]);
    const turns = extractOpencodeTurnsFromContent(content);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ index: 0, text: 'OPENCODE_OK' });
  });
});

// ---------------------------------------------------------------------------
// extractOpencodeActionsFromContent — reliable fields (high confidence)
// ---------------------------------------------------------------------------

describe('extractOpencodeActionsFromContent — reliable fields', () => {
  test('empty string → empty manifest (no throw)', () => {
    const m = extractOpencodeActionsFromContent('');
    expect(m.toolsUsed).toEqual({});
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
    expect(m.filesRead).toEqual([]);
    expect(m.filesEdited).toEqual([]);
    expect(m.filesWritten).toEqual([]);
    expect(m.bashCommands).toEqual([]);
    expect(m.errors).toEqual([]);
  });

  test('malformed JSON → empty manifest (no throw)', () => {
    const m = extractOpencodeActionsFromContent('not valid json');
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
  });

  test('single assistant message → turnCount=1, finalMessage set', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('say hello')] },
      { role: 'assistant', parts: [textPart('OPENCODE_OK')] },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.finalMessage).toBe('OPENCODE_OK');
    expect(m.turnCount).toBe(1);
  });

  test('multi-turn: turnCount equals number of assistant messages', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q1')] },
      { role: 'assistant', parts: [textPart('a1')] },
      { role: 'user', parts: [textPart('q2')] },
      { role: 'assistant', parts: [textPart('a2')] },
      { role: 'user', parts: [textPart('q3')] },
      { role: 'assistant', parts: [textPart('a3')] },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.turnCount).toBe(3);
    expect(m.finalMessage).toBe('a3');
  });

  test('finalMessage is last assistant text (not user or system)', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('question')] },
      { role: 'assistant', parts: [textPart('answer')] },
      { role: 'system', parts: [textPart('system note')] },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.finalMessage).toBe('answer');
    expect(m.turnCount).toBe(1);
  });

  test('empty messages array → empty manifest', () => {
    const content = makeExportJson([]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
    expect(m.toolsUsed).toEqual({});
  });

  test('text-only session (no tool parts) → empty tool fields, valid finalMessage', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('hi')] },
      {
        role: 'assistant',
        parts: [stepStartPart(), textPart('just chat'), stepFinishPart()],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({});
    expect(m.filesRead).toEqual([]);
    expect(m.bashCommands).toEqual([]);
    expect(m.finalMessage).toBe('just chat');
    expect(m.turnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractOpencodeActionsFromContent — defensive tool extraction (medium confidence)
//
// Tool-call part shape is INFERRED (not verified against real transcript).
// The assumed shape is documented at the top of this file.
// ---------------------------------------------------------------------------

describe('extractOpencodeActionsFromContent — defensive tool extraction', () => {
  test('tool-call part with Read + file_path → filesRead populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolCallPart('Read', { file_path: '/repo/foo.ts' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ Read: 1 });
    expect(m.filesRead).toEqual(['/repo/foo.ts']);
  });

  test('tool-call part with Edit + file_path → filesEdited populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolCallPart('Edit', { file_path: '/repo/a.ts' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ Edit: 1 });
    expect(m.filesEdited).toEqual(['/repo/a.ts']);
  });

  test('tool-call part with Write + file_path → filesWritten populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolCallPart('Write', { file_path: '/repo/new.ts' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ Write: 1 });
    expect(m.filesWritten).toEqual(['/repo/new.ts']);
  });

  test('tool-call part with Bash + command → bashCommands populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolCallPart('Bash', { command: 'bun test' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ Bash: 1 });
    expect(m.bashCommands).toEqual(['bun test']);
  });

  test('multiple tool calls across turns → counts and per-tool fields accumulated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q1')] },
      {
        role: 'assistant',
        parts: [
          toolCallPart('Read', { file_path: '/repo/a.ts' }),
          toolCallPart('Edit', { file_path: '/repo/b.ts' }),
          textPart('a1'),
        ],
      },
      { role: 'user', parts: [textPart('q2')] },
      {
        role: 'assistant',
        parts: [toolCallPart('Bash', { command: 'ls' }), textPart('a2')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ Read: 1, Edit: 1, Bash: 1 });
    expect(m.filesRead).toEqual(['/repo/a.ts']);
    expect(m.filesEdited).toEqual(['/repo/b.ts']);
    expect(m.bashCommands).toEqual(['ls']);
    expect(m.turnCount).toBe(2);
  });

  test('tool-call part with `input` field (alternative shape) is also accepted', () => {
    // Accept both `args` and `input` field names, mirroring codex/gemini defensiveness.
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool-call', toolName: 'Read', input: { file_path: '/repo/alt.ts' } },
          textPart('done'),
        ],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ Read: 1 });
    expect(m.filesRead).toEqual(['/repo/alt.ts']);
  });

  test('unknown tool just gets counted, unknown args gracefully ignored', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolCallPart('SomeFuture', { random_arg: 'value' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ SomeFuture: 1 });
    expect(m.filesRead).toEqual([]);
  });

  test('filesRead is deduplicated (same file read twice → one entry)', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [
          toolCallPart('Read', { file_path: '/repo/foo.ts' }),
          toolCallPart('Read', { file_path: '/repo/foo.ts' }),
          textPart('done'),
        ],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ Read: 2 });
    expect(m.filesRead).toEqual(['/repo/foo.ts']);
  });

  test('tool-result-error part → errors populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [
          toolCallPart('Edit', { file_path: '/missing.ts' }),
          toolResultErrorPart('File not found'),
          textPart('failed'),
        ],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.errors).toEqual(['File not found']);
  });

  test('tool part with neither `args` nor `input` → tool still counted, fields empty', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [{ type: 'tool-call', toolName: 'Read' }, textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ Read: 1 });
    expect(m.filesRead).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OpenCodeProvider wiring — extractActions and extractTurns delegates
// ---------------------------------------------------------------------------

import { OpenCodeProvider } from '../../../src/core/providers/opencode.ts';

describe('OpenCodeProvider.extractActions', () => {
  test('is defined', () => {
    expect(OpenCodeProvider.extractActions).toBeDefined();
  });

  test('delegates to extractOpencodeActionsFromContent', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('hi')] },
      { role: 'assistant', parts: [textPart('OPENCODE_OK')] },
    ]);
    const m = OpenCodeProvider.extractActions?.(content);
    expect(m?.finalMessage).toBe('OPENCODE_OK');
    expect(m?.turnCount).toBe(1);
  });

  test('returns empty manifest on empty string (no throw)', () => {
    const m = OpenCodeProvider.extractActions?.('');
    expect(m?.turnCount).toBe(0);
    expect(m?.finalMessage).toBe('');
  });
});

describe('OpenCodeProvider.extractTurns', () => {
  test('is defined', () => {
    expect(OpenCodeProvider.extractTurns).toBeDefined();
  });

  test('delegates to extractOpencodeTurnsFromContent', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      { role: 'assistant', parts: [textPart('A')] },
    ]);
    const turns = OpenCodeProvider.extractTurns?.(content);
    expect(turns).toEqual([{ index: 0, text: 'A' }]);
  });

  test('returns empty array on empty string (no throw)', () => {
    expect(OpenCodeProvider.extractTurns?.('')).toEqual([]);
  });
});
