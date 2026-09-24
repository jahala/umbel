import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgyProvider,
  agyTurnEnded,
  extractAgyActionsFromContent,
  extractAgyTurnsFromContent,
  parseAgyTranscript,
} from '../../../src/core/providers/agy.ts';

const FIXTURES = join(import.meta.dir, '../../fixtures/agy');
const fixture = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

const TWO_TURNS = fixture('1.2.10-two-turns.jsonl');
const TOOLS = fixture('1.2.10-tools.jsonl');
const DENIED = fixture('1.2.10-denied.jsonl');
const ERROR = fixture('1.2.10-error.jsonl');

const SIGN_IN_PANE = readFileSync(
  join(import.meta.dir, '../../fixtures/sign-in/agy-1.2.10-sign-in.txt'),
  'utf8',
);

type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// AgyProvider.buildLaunch
// ---------------------------------------------------------------------------

type AgyLaunchOpts = Parameters<typeof AgyProvider.buildLaunch>[0];

function launch(extra?: Partial<AgyLaunchOpts>): ReturnType<typeof AgyProvider.buildLaunch> {
  return AgyProvider.buildLaunch({
    sessionId: 'test-session',
    cwd: '/home/user/project',
    hookScriptPath: '/umbel/hooks/stop.sh',
    ...extra,
  });
}

describe('AgyProvider.buildLaunch', () => {
  test('bin is agy', () => {
    expect(launch().bin).toBe('agy');
  });

  test('args carry the stream-json format flags, --add-dir at cwd, and end in -p=', () => {
    const args = launch().args;
    expect(args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--add-dir',
      '/home/user/project',
      '-p=',
    ]);
  });

  test('--add-dir prefers realCwd over cwd', () => {
    const args = launch({ cwd: '/home/user/project', realCwd: '/private/tmp/wt' }).args;
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/private/tmp/wt');
  });

  test('unattended adds --dangerously-skip-permissions before --model, after --add-dir', () => {
    const args = launch({ unattended: true, model: 'fake-agy-pro' }).args;
    expect(args).toContain('--dangerously-skip-permissions');
    const addDirValueIdx = args.indexOf('--add-dir') + 1;
    const skipIdx = args.indexOf('--dangerously-skip-permissions');
    const modelFlagIdx = args.indexOf('--model');
    expect(skipIdx).toBeGreaterThan(addDirValueIdx);
    expect(modelFlagIdx).toBeGreaterThan(skipIdx);
    expect(args[modelFlagIdx + 1]).toBe('fake-agy-pro');
  });

  test('without unattended, no skip-permissions flag', () => {
    expect(launch().args).not.toContain('--dangerously-skip-permissions');
  });

  test('without model, no --model flag', () => {
    expect(launch().args).not.toContain('--model');
  });

  test('-p= is always the last argument', () => {
    expect(launch({ unattended: true, model: 'x' }).args.at(-1)).toBe('-p=');
  });

  test('env is empty and no files are materialized', () => {
    const spec = launch();
    expect(spec.env).toEqual({});
    expect(spec.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AgyProvider declared fields
// ---------------------------------------------------------------------------

describe('AgyProvider declared fields', () => {
  test('name, supportsUnattended, stopEventName', () => {
    expect(AgyProvider.name).toBe('agy');
    expect(AgyProvider.supportsUnattended).toBe(true);
    expect(AgyProvider.stopEventName).toBe('result');
  });

  test('no inheritEnv — agy inherits nothing of the caller', () => {
    expect(AgyProvider.inheritEnv).toBeUndefined();
  });

  test('no startupDialogs', () => {
    expect(AgyProvider.startupDialogs ?? []).toEqual([]);
  });

  test('no readySettleMs', () => {
    expect(AgyProvider.readySettleMs).toBeUndefined();
  });

  test('listModels(bin) returns [bin, "models"]', () => {
    expect(AgyProvider.listModels?.('agy')).toEqual(['agy', 'models']);
    expect(AgyProvider.listModels?.('/usr/local/bin/agy')).toEqual([
      '/usr/local/bin/agy',
      'models',
    ]);
  });
});

// ---------------------------------------------------------------------------
// stream.encodePrompt / turnEndPrefix
// ---------------------------------------------------------------------------

describe('AgyProvider.stream', () => {
  test('encodePrompt builds the user event envelope', () => {
    const line = AgyProvider.stream?.encodePrompt('hello') ?? '';
    expect(JSON.parse(line)).toEqual({
      event: 'user',
      message: { role: 'user', content: 'hello' },
    });
  });

  test('encodePrompt returns a single line even for a multi-line prompt', () => {
    const prompt = 'line one\nline two\nline three';
    const line = AgyProvider.stream?.encodePrompt(prompt) ?? '';
    expect(line.split('\n')).toHaveLength(1);
    expect(JSON.parse(line).message.content).toBe(prompt);
  });

  test('turnEndPrefix matches a result line', () => {
    const prefix = AgyProvider.stream?.turnEndPrefix ?? '';
    const resultLine = TWO_TURNS.split('\n').find((l) => l.includes('"event":"result"')) ?? '';
    expect(resultLine.startsWith(prefix)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signInMatch / readyMatch
// ---------------------------------------------------------------------------

describe('AgyProvider.signInMatch', () => {
  test('matches the real sign-in pane', () => {
    expect(AgyProvider.signInMatch?.test(SIGN_IN_PANE)).toBe(true);
  });

  test('does not match the phrase embedded in a longer line', () => {
    const worker =
      'The agy CLI prints "Authentication required. Please visit the URL to log in:" on stderr.';
    expect(AgyProvider.signInMatch?.test(worker)).toBe(false);
  });

  test('does not match unrelated pane text', () => {
    expect(AgyProvider.signInMatch?.test('{"event":"init","init":{}}')).toBe(false);
  });
});

describe('AgyProvider.readyMatch', () => {
  test('matches the init line', () => {
    const initLine = TWO_TURNS.split('\n')[0] ?? '';
    expect(AgyProvider.readyMatch?.test(initLine)).toBe(true);
  });

  test('does not match a step_update or result line', () => {
    const resultLine = TWO_TURNS.split('\n').find((l) => l.includes('"event":"result"')) ?? '';
    expect(AgyProvider.readyMatch?.test(resultLine)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAgyTranscript / AgyProvider.parseTranscript — real fixtures
// ---------------------------------------------------------------------------

describe('parseAgyTranscript', () => {
  test('two-turns: newest result wins, trailing newline trimmed', () => {
    expect(parseAgyTranscript(TWO_TURNS)).toBe('two');
  });

  test('tools: SUCCESS response trimmed of trailing newline', () => {
    expect(parseAgyTranscript(TOOLS)).toBe('done');
  });

  test('denied: SUCCESS with empty response', () => {
    expect(parseAgyTranscript(DENIED)).toBe('');
  });

  test('error: ERROR status returns the error text, not the empty response', () => {
    expect(parseAgyTranscript(ERROR)).toBe('stream input message is missing the "event" field');
  });

  test('no result event → empty string', () => {
    expect(parseAgyTranscript('{"event":"init","init":{}}')).toBe('');
  });

  test('empty content → empty string', () => {
    expect(parseAgyTranscript('')).toBe('');
  });

  test('malformed lines are skipped, not thrown', () => {
    const content = ['not json', '{partial', TWO_TURNS].join('\n');
    expect(parseAgyTranscript(content)).toBe('two');
  });

  test('AgyProvider.parseTranscript delegates to the same logic', () => {
    expect(AgyProvider.parseTranscript(TWO_TURNS)).toBe(parseAgyTranscript(TWO_TURNS));
  });
});

// ---------------------------------------------------------------------------
// agyTurnEnded
// ---------------------------------------------------------------------------

describe('agyTurnEnded', () => {
  test('a transcript ending in a result is closed', () => {
    expect(agyTurnEnded(TWO_TURNS)).toBe(true);
    expect(agyTurnEnded(TOOLS)).toBe(true);
    expect(agyTurnEnded(DENIED)).toBe(true);
    expect(agyTurnEnded(ERROR)).toBe(true);
  });

  test('a transcript with no markers cannot prove a turn open — answers true', () => {
    expect(agyTurnEnded('{"event":"init","init":{}}')).toBe(true);
    expect(agyTurnEnded('')).toBe(true);
  });

  test('unparseable content answers true, never stalling a read', () => {
    expect(agyTurnEnded('not json at all')).toBe(true);
  });

  test('a user_input step_update after the last result means the turn is open', () => {
    const openTurn = [
      TWO_TURNS.trimEnd(),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'x',
          step_index: 4,
          state: 'DONE',
          step_type: 'user_input',
        },
      }),
    ].join('\n');
    expect(agyTurnEnded(openTurn)).toBe(false);
  });

  test('AgyProvider.turnEnded delegates to the same logic', () => {
    expect(AgyProvider.turnEnded?.(TWO_TURNS)).toBe(agyTurnEnded(TWO_TURNS));
  });
});

// ---------------------------------------------------------------------------
// extractAgyTurnsFromContent
// ---------------------------------------------------------------------------

describe('extractAgyTurnsFromContent', () => {
  test('two-turns: one Turn per result, in order', () => {
    expect(extractAgyTurnsFromContent(TWO_TURNS)).toEqual([
      { index: 0, text: 'one' },
      { index: 1, text: 'two' },
    ]);
  });

  test('error fixture: one Turn carrying the error text', () => {
    expect(extractAgyTurnsFromContent(ERROR)).toEqual([
      { index: 0, text: 'stream input message is missing the "event" field' },
    ]);
  });

  test('no result events → empty array', () => {
    expect(extractAgyTurnsFromContent('{"event":"init","init":{}}')).toEqual([]);
  });

  test('empty content → empty array', () => {
    expect(extractAgyTurnsFromContent('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractAgyActionsFromContent
// ---------------------------------------------------------------------------

describe('extractAgyActionsFromContent', () => {
  test('tools fixture: DONE tools counted and categorized, ERROR tool only in errors', () => {
    const m = extractAgyActionsFromContent(TOOLS);
    expect(m.toolsUsed).toEqual({ view_file: 2, replace_file_content: 1 });
    expect(m.filesRead).toEqual(['/tmp/agyprobe.AUk82V/c.txt']);
    expect(m.filesEdited).toEqual(['/tmp/agyprobe.AUk82V/c.txt']);
    expect(m.filesWritten).toEqual([]);
    expect(m.bashCommands).toEqual([]);
    expect(m.errors).toEqual([
      'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) failed to read file: stat /nonexistent/zzz.txt: no such file or directory',
    ]);
    expect(m.finalMessage).toBe('done');
    expect(m.turnCount).toBe(1);
  });

  test('denied fixture: ERROR tool step and denied_actions both land in errors, nothing in filesWritten', () => {
    const m = extractAgyActionsFromContent(DENIED);
    expect(m.toolsUsed).toEqual({ write_to_file: 1 });
    expect(m.filesWritten).toEqual([]);
    expect(m.errors).toEqual([
      'permission check failed for write_file "/private/tmp/agyprobe.AUk82V/b.txt": user denied permission for write_file(/private/tmp/agyprobe.AUk82V/b.txt)\nDo not attempt to circumvent this denial by rephrasing the command, using alternative tools/scripts (e.g. python, sh, curl), or accessing the same target resource. Proceed without performing this action.',
      'permission denied: write_file',
    ]);
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(1);
  });

  test('error fixture: result status ERROR contributes its text to errors', () => {
    const m = extractAgyActionsFromContent(ERROR);
    expect(m.errors).toEqual(['stream input message is missing the "event" field']);
    expect(m.toolsUsed).toEqual({});
    expect(m.finalMessage).toBe('stream input message is missing the "event" field');
    expect(m.turnCount).toBe(1);
  });

  test('two-turns fixture: no tools, turnCount matches number of results', () => {
    const m = extractAgyActionsFromContent(TWO_TURNS);
    expect(m.toolsUsed).toEqual({});
    expect(m.bashCommands).toEqual([]);
    expect(m.turnCount).toBe(2);
    expect(m.finalMessage).toBe('two');
  });

  test('run_command DONE step → bashCommands from CommandLine, in order', () => {
    const line = (i: number, state: string, extra: JsonRecord) =>
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: 'x', step_index: i, state, step_type: 'tool', ...extra },
      });
    const content = [
      line(1, 'ACTIVE', {
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } },
      }),
      line(1, 'DONE', {
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' }, output: 'ok' },
      }),
    ].join('\n');
    const m = extractAgyActionsFromContent(content);
    expect(m.bashCommands).toEqual(['ls -la']);
    expect(m.toolsUsed).toEqual({ run_command: 1 });
  });

  test('ACTIVE-only tool step is not counted (only DONE/ERROR terminal states are)', () => {
    const content = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'x',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } },
      },
    });
    const m = extractAgyActionsFromContent(content);
    expect(m.toolsUsed).toEqual({});
    expect(m.bashCommands).toEqual([]);
  });

  test('multi_replace_file_content and sed_file count in toolsUsed and their TargetFile lands in filesEdited', () => {
    const line = (tool: string, path: string) =>
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'x',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: tool,
          tool_info: { name: tool, parameters: { TargetFile: path } },
        },
      });
    const content = [line('multi_replace_file_content', '/a.ts'), line('sed_file', '/b.ts')].join(
      '\n',
    );
    const m = extractAgyActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ multi_replace_file_content: 1, sed_file: 1 });
    expect(m.filesEdited).toEqual(['/a.ts', '/b.ts']);
  });

  test('an unrelated tool is counted in toolsUsed with no other categorization', () => {
    const content = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'x',
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'search_web',
        tool_info: { name: 'search_web', parameters: { query: 'agy cli' } },
      },
    });
    const m = extractAgyActionsFromContent(content);
    expect(m.toolsUsed).toEqual({ search_web: 1 });
    expect(m.filesRead).toEqual([]);
    expect(m.filesWritten).toEqual([]);
    expect(m.filesEdited).toEqual([]);
    expect(m.bashCommands).toEqual([]);
  });

  test('malformed lines are skipped, not thrown', () => {
    const content = ['not json', '{partial', TWO_TURNS].join('\n');
    const m = extractAgyActionsFromContent(content);
    expect(m.turnCount).toBe(2);
    expect(m.finalMessage).toBe('two');
  });

  test('empty content → empty manifest', () => {
    const m = extractAgyActionsFromContent('');
    expect(m.toolsUsed).toEqual({});
    expect(m.filesRead).toEqual([]);
    expect(m.filesEdited).toEqual([]);
    expect(m.filesWritten).toEqual([]);
    expect(m.bashCommands).toEqual([]);
    expect(m.errors).toEqual([]);
    expect(m.finalMessage).toBe('');
    expect(m.turnCount).toBe(0);
  });

  test('AgyProvider.extractActions delegates to the same logic', () => {
    expect(AgyProvider.extractActions?.(TOOLS)).toEqual(extractAgyActionsFromContent(TOOLS));
  });
});
