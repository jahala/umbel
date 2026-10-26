import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
// Part types observed: step-start, reasoning, text, step-finish, tool.
//
// Tool part shape, recorded from opencode 1.18.18 (test/fixtures/opencode/):
//   { type: 'tool', tool: 'bash' | 'read' | 'edit' | 'write' | ...,
//     state: { status: 'completed' | 'error' | ..., input: {...},
//              output?: string, error?: string, metadata?: { exit?: number } } }
// bash takes input.command; read, edit and write take input.filePath. A failed
// tool has status 'error' and the message in state.error; a shell command that
// exits non-zero stays 'completed' and records the code in metadata.exit.

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

// A finished tool call, in the recorded shape (see the comment at the top).
function toolPart(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: 'tool', tool, state: { status: 'completed', input } };
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
  test('read tool with filePath → filesRead populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolPart('read', { filePath: '/repo/foo.ts' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ read: 1 });
    expect(m.filesRead).toEqual(['/repo/foo.ts']);
  });

  test('edit tool with filePath → filesEdited populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolPart('edit', { filePath: '/repo/a.ts' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ edit: 1 });
    expect(m.filesEdited).toEqual(['/repo/a.ts']);
  });

  test('write tool with filePath → filesWritten populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolPart('write', { filePath: '/repo/new.ts' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ write: 1 });
    expect(m.filesWritten).toEqual(['/repo/new.ts']);
  });

  test('bash tool with command → bashCommands populated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolPart('bash', { command: 'bun test' }), textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ bash: 1 });
    expect(m.bashCommands).toEqual(['bun test']);
  });

  test('multiple tool calls across turns → counts and per-tool fields accumulated', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q1')] },
      {
        role: 'assistant',
        parts: [
          toolPart('read', { filePath: '/repo/a.ts' }),
          toolPart('edit', { filePath: '/repo/b.ts' }),
          textPart('a1'),
        ],
      },
      { role: 'user', parts: [textPart('q2')] },
      {
        role: 'assistant',
        parts: [toolPart('bash', { command: 'ls' }), textPart('a2')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ read: 1, edit: 1, bash: 1 });
    expect(m.filesRead).toEqual(['/repo/a.ts']);
    expect(m.filesEdited).toEqual(['/repo/b.ts']);
    expect(m.bashCommands).toEqual(['ls']);
    expect(m.turnCount).toBe(2);
  });

  test('a tool still running is counted, and its file read', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            tool: 'read',
            state: { status: 'running', input: { filePath: '/repo/alt.ts' } },
          },
          textPart('done'),
        ],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ read: 1 });
    expect(m.filesRead).toEqual(['/repo/alt.ts']);
  });

  test('unknown tool just gets counted, unknown args gracefully ignored', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [toolPart('SomeFuture', { random_arg: 'value' }), textPart('done')],
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
          toolPart('read', { filePath: '/repo/foo.ts' }),
          toolPart('read', { filePath: '/repo/foo.ts' }),
          textPart('done'),
        ],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ read: 2 });
    expect(m.filesRead).toEqual(['/repo/foo.ts']);
  });

  test('a tool that failed → its error message in errors', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            tool: 'edit',
            state: { status: 'error', input: { filePath: '/missing.ts' }, error: 'File not found' },
          },
          textPart('failed'),
        ],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.errors).toEqual(['File not found']);
  });

  test('a tool part with no state → tool still counted, fields empty', () => {
    const content = makeExportJson([
      { role: 'user', parts: [textPart('q')] },
      {
        role: 'assistant',
        parts: [{ type: 'tool', tool: 'read' }, textPart('done')],
      },
    ]);
    const m = extractOpencodeActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ read: 1 });
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

// Real opencode 1.18.18 exports, trimmed (umbel#148).
function recorded(name: string): string {
  return readFileSync(join(import.meta.dir, '../../fixtures/opencode', name), 'utf8');
}

describe('extractOpencodeActionsFromContent — recorded opencode 1.18.18 exports', () => {
  test('shell calls: counted, commands in order, a non-zero exit is an error', () => {
    const m = extractOpencodeActionsFromContent(recorded('1.18.18-tool-export.json'));
    expect(m.toolsUsed).toEqual({ bash: 2 });
    expect(m.bashCommands).toEqual(['ls -la', 'ls does-not-exist .']);
    expect(m.errors).toEqual([
      'ls does-not-exist . exited 1: ls: does-not-exist: No such file or directory',
    ]);
    expect(m.finalMessage).toBe('done');
  });

  test('file tools: read, edit and write by filePath, a failed read is an error', () => {
    const m = extractOpencodeActionsFromContent(recorded('1.18.18-file-tools-export.json'));
    expect(m.toolsUsed).toEqual({ read: 2, edit: 1, write: 1 });
    expect(m.filesRead).toEqual(['/work/a.txt', '/work/missing.txt']);
    expect(m.filesEdited).toEqual(['/work/a.txt']);
    expect(m.filesWritten).toEqual(['/work/b.txt']);
    expect(m.errors).toEqual(['File not found: /work/missing.txt']);
  });
});
