import { describe, expect, test } from 'bun:test';
import {
  extractActionsFromContent,
  extractTurnsFromContent,
} from '../../../src/core/providers/claude.ts';

// ---------------------------------------------------------------------------
// Helpers — build synthetic Claude JSONL inline so tests are self-contained
// and don't depend on fake-claude.sh emitting tool_use blocks (it doesn't).
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text: string }>;
  is_error?: boolean;
}

function assistantLine(content: ContentBlock[], stopReason: string | null = 'end_turn'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content, stop_reason: stopReason },
  });
}

function userLine(content: ContentBlock[]): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  });
}

function humanPromptLine(text: string): string {
  return userLine([{ type: 'text', text }]);
}

function toolUseBlock(name: string, input: Record<string, unknown>, id = 'toolu_x'): ContentBlock {
  return { type: 'tool_use', name, input, tool_use_id: id };
}

function toolResultBlock(content: string, isError = false, id = 'toolu_x'): ContentBlock {
  const b: ContentBlock = { type: 'tool_result', tool_use_id: id, content };
  if (isError) b.is_error = true;
  return b;
}

// ---------------------------------------------------------------------------
// extractActionsFromContent
// ---------------------------------------------------------------------------

describe('extractActionsFromContent', () => {
  test('empty content returns empty manifest with turnCount=0', () => {
    const m = extractActionsFromContent('');
    expect(m.toolsUsed).toEqual({});
    expect(m.filesRead).toEqual([]);
    expect(m.filesEdited).toEqual([]);
    expect(m.filesWritten).toEqual([]);
    expect(m.bashCommands).toEqual([]);
    expect(m.errors).toEqual([]);
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
  });

  test('single Read tool_use → filesRead has the file path', () => {
    const jsonl = [
      humanPromptLine('read foo'),
      assistantLine([toolUseBlock('Read', { file_path: '/repo/src/foo.ts' })], 'tool_use'),
      userLine([toolResultBlock('file contents...')]),
      assistantLine([{ type: 'text', text: 'Done.' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Read: 1 });
    expect(m.filesRead).toEqual(['/repo/src/foo.ts']);
    expect(m.finalMessage).toBe('Done.');
    expect(m.turnCount).toBe(1);
  });

  test('Edit + Bash mixed → toolsUsed counts and per-tool fields populated', () => {
    const jsonl = [
      humanPromptLine('fix and test'),
      assistantLine(
        [
          toolUseBlock('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }),
          toolUseBlock('Edit', { file_path: '/repo/b.ts', old_string: 'x', new_string: 'y' }),
          toolUseBlock('Bash', { command: 'bun test' }),
        ],
        'tool_use',
      ),
      userLine([toolResultBlock('edit ok'), toolResultBlock('tests pass')]),
      assistantLine([{ type: 'text', text: 'All tests pass.' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Edit: 2, Bash: 1 });
    expect(m.filesEdited).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(m.bashCommands).toEqual(['bun test']);
    expect(m.finalMessage).toBe('All tests pass.');
  });

  test('repeated file in tool_use is deduplicated in files list', () => {
    const jsonl = [
      humanPromptLine('read twice'),
      assistantLine(
        [
          toolUseBlock('Read', { file_path: '/repo/foo.ts' }),
          toolUseBlock('Read', { file_path: '/repo/foo.ts' }),
        ],
        'tool_use',
      ),
      userLine([toolResultBlock('content')]),
      assistantLine([{ type: 'text', text: 'Done' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.toolsUsed.Read).toBe(2); // count includes repeats
    expect(m.filesRead).toEqual(['/repo/foo.ts']); // but files list dedupes
  });

  test('Write tool → filesWritten', () => {
    const jsonl = [
      humanPromptLine('write a file'),
      assistantLine(
        [toolUseBlock('Write', { file_path: '/repo/new.md', content: 'hello' })],
        'tool_use',
      ),
      userLine([toolResultBlock('written')]),
      assistantLine([{ type: 'text', text: 'Done' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.filesWritten).toEqual(['/repo/new.md']);
    expect(m.toolsUsed).toEqual({ Write: 1 });
  });

  test('MultiEdit tool → filesEdited (treated like Edit)', () => {
    const jsonl = [
      humanPromptLine('multi-edit'),
      assistantLine(
        [toolUseBlock('MultiEdit', { file_path: '/repo/multi.ts', edits: [] })],
        'tool_use',
      ),
      userLine([toolResultBlock('multi-edit ok')]),
      assistantLine([{ type: 'text', text: 'Done' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.filesEdited).toEqual(['/repo/multi.ts']);
    expect(m.toolsUsed).toEqual({ MultiEdit: 1 });
  });

  test('tool_result with is_error:true (string content) is captured', () => {
    const jsonl = [
      humanPromptLine('try edit'),
      assistantLine(
        [toolUseBlock('Edit', { file_path: '/missing.ts', old_string: 'x', new_string: 'y' })],
        'tool_use',
      ),
      userLine([toolResultBlock('File not found: /missing.ts', true)]),
      assistantLine([{ type: 'text', text: 'Failed.' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.errors).toEqual(['File not found: /missing.ts']);
  });

  test('tool_result with is_error:true and array content is concatenated', () => {
    const jsonl = [
      humanPromptLine('try'),
      assistantLine([toolUseBlock('Bash', { command: 'false' })], 'tool_use'),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_x',
              content: [
                { type: 'text', text: 'stderr line 1\n' },
                { type: 'text', text: 'stderr line 2' },
              ],
              is_error: true,
            },
          ],
        },
      }),
      assistantLine([{ type: 'text', text: 'OK' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.errors).toEqual(['stderr line 1\nstderr line 2']);
  });

  test('tool_result without is_error is NOT captured', () => {
    const jsonl = [
      humanPromptLine('ok run'),
      assistantLine([toolUseBlock('Bash', { command: 'true' })], 'tool_use'),
      userLine([toolResultBlock('ok')]),
      assistantLine([{ type: 'text', text: 'Done' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.errors).toEqual([]);
  });

  test('multi-turn: turnCount equals number of end_turn assistant entries', () => {
    const jsonl = [
      humanPromptLine('q1'),
      assistantLine([{ type: 'text', text: 'a1' }]),
      humanPromptLine('q2'),
      assistantLine([{ type: 'text', text: 'a2' }]),
      humanPromptLine('q3'),
      assistantLine([{ type: 'text', text: 'a3' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.turnCount).toBe(3);
    expect(m.finalMessage).toBe('a3');
  });

  test('malformed JSON lines are silently skipped', () => {
    const jsonl = [
      humanPromptLine('hi'),
      '{not json',
      assistantLine([{ type: 'text', text: 'still works' }]),
      'definitely not json either',
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.finalMessage).toBe('still works');
    expect(m.turnCount).toBe(1);
  });

  test('no assistant entries → finalMessage is empty, turnCount=0', () => {
    const jsonl = [humanPromptLine('hello'), humanPromptLine('still no answer')].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
  });

  test('unknown tool just gets counted (no special field extraction)', () => {
    const jsonl = [
      humanPromptLine('use exotic'),
      assistantLine([toolUseBlock('SomeFutureTool', { random_arg: 'value' })], 'tool_use'),
      userLine([toolResultBlock('ok')]),
      assistantLine([{ type: 'text', text: 'Done' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ SomeFutureTool: 1 });
    expect(m.filesRead).toEqual([]);
    expect(m.filesEdited).toEqual([]);
    expect(m.filesWritten).toEqual([]);
  });

  test('tool_use without input field does not crash (total function)', () => {
    const jsonl = [
      humanPromptLine('weird tool'),
      assistantLine(
        [{ type: 'tool_use', name: 'Read', tool_use_id: 'x' } as ContentBlock],
        'tool_use',
      ),
      assistantLine([{ type: 'text', text: 'Done' }]),
    ].join('\n');
    const m = extractActionsFromContent(jsonl);
    expect(m.toolsUsed).toEqual({ Read: 1 });
    expect(m.filesRead).toEqual([]); // no file_path → nothing added
  });
});

// ---------------------------------------------------------------------------
// extractTurnsFromContent
// ---------------------------------------------------------------------------

describe('extractTurnsFromContent', () => {
  test('empty content → empty array', () => {
    expect(extractTurnsFromContent('')).toEqual([]);
  });

  test('single turn → one entry at index 0', () => {
    const jsonl = [humanPromptLine('q'), assistantLine([{ type: 'text', text: 'A' }])].join('\n');
    expect(extractTurnsFromContent(jsonl)).toEqual([{ index: 0, text: 'A' }]);
  });

  test('three turns → indices 0,1,2 in order', () => {
    const jsonl = [
      humanPromptLine('q1'),
      assistantLine([{ type: 'text', text: 'a1' }]),
      humanPromptLine('q2'),
      assistantLine([{ type: 'text', text: 'a2' }]),
      humanPromptLine('q3'),
      assistantLine([{ type: 'text', text: 'a3' }]),
    ].join('\n');
    expect(extractTurnsFromContent(jsonl)).toEqual([
      { index: 0, text: 'a1' },
      { index: 1, text: 'a2' },
      { index: 2, text: 'a3' },
    ]);
  });

  test('intermediate assistant entries (stop_reason: tool_use) are NOT counted as turns', () => {
    const jsonl = [
      humanPromptLine('q'),
      assistantLine([toolUseBlock('Read', { file_path: '/x' })], 'tool_use'), // not a turn
      userLine([toolResultBlock('ok')]),
      assistantLine([{ type: 'text', text: 'Final' }]), // turn 0
    ].join('\n');
    expect(extractTurnsFromContent(jsonl)).toEqual([{ index: 0, text: 'Final' }]);
  });

  test('malformed lines do not throw', () => {
    const jsonl = [
      humanPromptLine('q'),
      'gibberish line',
      assistantLine([{ type: 'text', text: 'A' }]),
    ].join('\n');
    expect(extractTurnsFromContent(jsonl)).toEqual([{ index: 0, text: 'A' }]);
  });

  test('empty assistant text → empty string, still a turn', () => {
    const jsonl = [
      humanPromptLine('q'),
      assistantLine([]), // empty content array
    ].join('\n');
    expect(extractTurnsFromContent(jsonl)).toEqual([{ index: 0, text: '' }]);
  });
});
