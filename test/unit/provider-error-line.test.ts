import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inputMessage, providerErrorLine } from '../../src/core/idle.ts';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';

// ---------------------------------------------------------------------------
// umbel#129: when a provider refuses the turn (out of credit), claude prints
// the API error and fires only its idle notification. The wait settles `input`,
// and the provider's own line is what tells a caller to recast the work instead
// of answering a question.
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, '../fixtures/error');
const pane = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

// The pane a DeepSeek-backed worker showed on 2026-10-22, after its account ran
// out of credit. The CLI renders the error with its message marker and wraps the
// request id onto an indented row.
const API_ERROR = pane('claude-api-error.txt');
const ERROR_MESSAGE =
  'API Error: 402 Insufficient Balance (request_id: 220c4fea-a416-4840-bfc6-68aa1de49bf3)';
const LIMIT = "You've hit your session limit · resets 4:30pm (Europe/Copenhagen)";

describe('providerErrorLine', () => {
  test('reads the real pane, joining the wrapped request id', () => {
    expect(providerErrorLine(API_ERROR, ClaudeProvider.errorMatch ?? [])).toBe(ERROR_MESSAGE);
  });

  test('trims the marker and any box border around the line', () => {
    expect(
      providerErrorLine(
        '│ ⏺ API Error: 529 overloaded            │\n',
        ClaudeProvider.errorMatch ?? [],
      ),
    ).toBe('API Error: 529 overloaded');
  });

  test("a worker's own output mentioning API Error is not the CLI's error line", () => {
    const patterns = ClaudeProvider.errorMatch ?? [];
    // A reply: the marker belongs to the reply, not to an error line.
    expect(providerErrorLine('⏺ The provider answered with API Error: 500\n', patterns)).toBe(
      undefined,
    );
    // Prose and a diff line, where the phrase sits inside other text.
    expect(providerErrorLine('  API Error: 500 was printed by the binary\n', patterns)).toBe(
      undefined,
    );
    expect(providerErrorLine('+⏺ API Error: 402 Insufficient Balance\n', patterns)).toBeUndefined();
  });

  test('undefined without a match or without patterns', () => {
    expect(providerErrorLine('❯ Working on it\n', ClaudeProvider.errorMatch ?? [])).toBeUndefined();
    expect(providerErrorLine(API_ERROR, [])).toBeUndefined();
    expect(providerErrorLine(API_ERROR, CodexProvider.errorMatch ?? [])).toBeUndefined();
  });
});

describe('inputMessage', () => {
  test('a limit dialog outranks an error line and carries the reset time', () => {
    expect(inputMessage(`${API_ERROR}${LIMIT}\n`, ClaudeProvider, 'Claude is waiting')).toBe(LIMIT);
  });

  test('the error line replaces the hook message', () => {
    expect(inputMessage(API_ERROR, ClaudeProvider, 'Claude is waiting')).toBe(ERROR_MESSAGE);
  });

  test('without either line the hook message stands', () => {
    expect(inputMessage('❯ Working on it\n', ClaudeProvider, 'Claude is waiting')).toBe(
      'Claude is waiting',
    );
    expect(inputMessage('❯ Working on it\n', undefined, 'Claude is waiting')).toBe(
      'Claude is waiting',
    );
  });
});
