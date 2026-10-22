import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function taskCompleteLine(lastAgentMessage?: string): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'event_msg',
    payload:
      lastAgentMessage === undefined
        ? { type: 'task_complete', usage: { input_tokens: 1, output_tokens: 1 } }
        : { type: 'task_complete', turn_id: 't', last_agent_message: lastAgentMessage },
  });
}

function itemCompletedLine(item: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'th', turn_id: 't', item },
  });
}

// The pre-0.154 shape: a function call and its output as response_items.
function functionCallLine(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: `c-${name}` },
  });
}

function functionCallOutputLine(output: string): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'c-output', output },
  });
}

function customToolCallLine(name: string, input: string): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call', name, input, call_id: `c-${name}` },
  });
}

function customToolCallOutputLine(firstText: string): string {
  return JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'c-output',
      output: [
        { type: 'input_text', text: `${firstText}\n` },
        { type: 'input_text', text: 'rest\n' },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Real codex-cli 0.154.0 rollout (two turns, trimmed; jahala/umbel#68)
// ---------------------------------------------------------------------------
//
// 0.154.0 records tool activity as event_msg/item_completed: CommandExecution
// carries the shell command, status and exit code; FileChange carries the
// applied patch's per-file changes. response_item/custom_tool_call is the
// model-facing call, and its output is where a script-level failure lands
// because no item_completed is written for one.

const ROLLOUT_0154 = readFileSync(
  join(import.meta.dir, '../../fixtures/codex-0.154-actions-rollout.jsonl'),
  'utf8',
);

describe('extractCodexActionsFromContent — real 0.154.0 rollout', () => {
  test('reports the commands, the edited file, both failures and the final message', () => {
    const m = extractCodexActionsFromContent(ROLLOUT_0154);

    expect(m.toolsUsed).toEqual({ exec_command: 4, apply_patch: 1 });
    expect(m.bashCommands).toEqual([
      'echo probe-ok',
      "printf 'hello-probe\\n' > notes.txt",
      'false',
      'ls notes.txt does-not-exist',
    ]);
    expect(m.filesRead).toEqual([]);
    expect(m.filesEdited).toEqual(['/private/tmp/umbel-actions-fixture/notes.txt']);
    expect(m.filesWritten).toEqual([]);
    expect(m.errors).toEqual(['exit code 1', 'ls: does-not-exist: No such file or directory']);
    expect(m.finalMessage).toBe(
      'Updated `notes.txt` to the two requested lines; `ls` failed because `does-not-exist` is missing.',
    );
    expect(m.turnCount).toBe(2);
  });
});

describe('extractCodexActionsFromContent — item_completed shapes', () => {
  test('CommandExecution with stderr reports the stderr line, not the exit code', () => {
    const content = [
      sessionMetaLine(),
      itemCompletedLine({
        type: 'CommandExecution',
        command: ['/bin/zsh', '-lc', 'bun test'],
        status: 'failed',
        exit_code: 1,
        stdout: '',
        stderr: 'TypeError: boom\n    at test.ts:1',
      }),
      taskCompleteLine('failed'),
    ].join('\n');

    expect(extractCodexActionsFromContent(content).errors).toEqual(['TypeError: boom']);
  });

  test('FileChange add goes to filesWritten, delete to filesEdited, move records both', () => {
    const content = [
      sessionMetaLine(),
      itemCompletedLine({
        type: 'FileChange',
        status: 'completed',
        changes: {
          '/repo/new.ts': { type: 'add', content: 'export {}' },
          '/repo/old.ts': { type: 'delete' },
          '/repo/from.ts': {
            type: 'update',
            unified_diff: '@@\n-a\n+b\n',
            move_path: '/repo/to.ts',
          },
        },
      }),
      taskCompleteLine('done'),
    ].join('\n');

    const m = extractCodexActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ apply_patch: 1 });
    expect(m.filesWritten.sort()).toEqual(['/repo/new.ts', '/repo/to.ts']);
    expect(m.filesEdited.sort()).toEqual(['/repo/from.ts', '/repo/old.ts']);
  });

  test('McpToolCall counts by server/tool and reports its error message', () => {
    const content = [
      sessionMetaLine(),
      itemCompletedLine({
        type: 'McpToolCall',
        server: 'github',
        tool: 'get_issue',
        status: 'failed',
        error: { message: 'not found' },
      }),
      taskCompleteLine('nope'),
    ].join('\n');

    const m = extractCodexActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ 'github/get_issue': 1 });
    expect(m.errors).toEqual(['not found']);
  });

  test('a script-level failure is reported even when command items exist', () => {
    const content = [
      sessionMetaLine(),
      itemCompletedLine({
        type: 'CommandExecution',
        command: ['/bin/zsh', '-lc', 'echo ok'],
        status: 'completed',
        exit_code: 0,
        stdout: 'ok\n',
        stderr: '',
      }),
      customToolCallOutputLine('Script error: Error: patch target not found'),
      taskCompleteLine('done'),
    ].join('\n');

    expect(extractCodexActionsFromContent(content).errors).toEqual([
      'Script error: Error: patch target not found',
    ]);
  });

  test('an AgentMessage item is not mistaken for a tool', () => {
    const content = [
      sessionMetaLine(),
      itemCompletedLine({
        type: 'AgentMessage',
        content: [{ type: 'Text', text: 'thinking' }],
        phase: 'final_answer',
      }),
      taskCompleteLine('thinking'),
    ].join('\n');

    expect(extractCodexActionsFromContent(content).toolsUsed).toEqual({});
  });
});

describe('extractCodexActionsFromContent — pre-0.154 rollout shapes', () => {
  test('function_call commands, apply_patch edits and a non-zero output exit', () => {
    const content = [
      sessionMetaLine(),
      functionCallLine('exec_command', { cmd: 'cat a.ts', workdir: '/repo', yield_time_ms: 1000 }),
      functionCallOutputLine('Chunk ID: 1\nProcess exited with code 0\nOutput:\nexport {}'),
      functionCallLine('exec_command', { cmd: 'cat missing.ts', workdir: '/repo' }),
      functionCallOutputLine(
        'Chunk ID: 2\nProcess exited with code 1\nOutput:\ncat: missing.ts: No such file or directory',
      ),
      customToolCallLine(
        'apply_patch',
        '*** Begin Patch\n*** Add File: /repo/b.ts\n+x\n*** Update File: /repo/a.ts\n@@\n-a\n+b\n*** End Patch',
      ),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          success: true,
          stdout: 'Success.',
          stderr: '',
          changes: { '/repo/b.ts': { type: 'add', content: 'x' } },
        },
      }),
      agentMessageLine('done'),
      taskCompleteLine(),
    ].join('\n');

    const m = extractCodexActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ exec_command: 2, apply_patch: 1 });
    expect(m.bashCommands).toEqual(['cat a.ts', 'cat missing.ts']);
    expect(m.filesWritten).toEqual(['/repo/b.ts']);
    expect(m.filesEdited).toEqual(['/repo/a.ts']);
    expect(m.errors).toEqual(['cat: missing.ts: No such file or directory']);
    expect(m.finalMessage).toBe('done');
    expect(m.turnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reliable surface (final-message + turnCount)
// ---------------------------------------------------------------------------

describe('extractCodexActionsFromContent — final message and turns', () => {
  test('empty content → empty manifest', () => {
    const m = extractCodexActionsFromContent('');
    expect(m.toolsUsed).toEqual({});
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
  });

  test('old agent_message shapes still supply the final message', () => {
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
    expect(m.finalMessage).toBe('a3');
  });

  test('task_complete.last_agent_message wins over an earlier AgentMessage item', () => {
    const jsonl = [
      sessionMetaLine(),
      itemCompletedLine({
        type: 'AgentMessage',
        content: [{ type: 'Text', text: 'from the item' }],
        phase: 'final_answer',
      }),
      taskCompleteLine('from task_complete'),
    ].join('\n');
    expect(extractCodexActionsFromContent(jsonl).finalMessage).toBe('from task_complete');
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

  test('text-only session → empty tools, valid finalMessage', () => {
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
