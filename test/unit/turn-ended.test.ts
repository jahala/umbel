import { describe, expect, test } from 'bun:test';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import type { AgentProvider } from '../../src/core/providers/types.ts';

// Throws rather than defaulting, so a provider without the method fails every
// case instead of passing the ones that expect true.
function ended(provider: AgentProvider, lines: string[]): boolean {
  if (provider.turnEnded === undefined) throw new Error(`${provider.name} has no turnEnded`);
  return provider.turnEnded(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// turnEnded: does the transcript already hold the end of the worker's turn?
//
// Shapes come from real transcripts. Claude writes one entry per content block
// and copies the whole message's stop_reason onto every one of them, so a
// thinking block of the final message already says end_turn. "A stop_reason is
// present" therefore proves nothing; only a text block that did not stop for a
// tool closes a turn. Codex brackets a turn with task_started and
// task_complete.
// ---------------------------------------------------------------------------

type Block = { type: string; text?: string };

function assistant(id: string, block: Block, stop: string | null): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', content: [block], stop_reason: stop },
  });
}

const prompt = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } });
const toolResult = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
});
const metadata = JSON.stringify({ type: 'system', subtype: 'turn_duration' });

const claude = (...lines: string[]): boolean => ended(ClaudeProvider, lines);

describe('ClaudeProvider.turnEnded', () => {
  test('a final text block closes the turn', () => {
    expect(claude(prompt, assistant('m', { type: 'text', text: 'done' }, 'end_turn'))).toBe(true);
  });

  test('metadata written after the final text does not reopen it', () => {
    expect(
      claude(prompt, assistant('m', { type: 'text', text: 'done' }, 'end_turn'), metadata),
    ).toBe(true);
  });

  test('a stop_sequence ending closes the turn', () => {
    expect(claude(prompt, assistant('m', { type: 'text', text: 'done' }, 'stop_sequence'))).toBe(
      true,
    );
  });

  test('the final message with only its thinking block flushed is still open', () => {
    // The "nothing" symptom: the entry already carries end_turn, yet no text.
    expect(claude(prompt, toolResult, assistant('m2', { type: 'thinking' }, 'end_turn'))).toBe(
      false,
    );
  });

  test('the previous message last on disk is still open', () => {
    // The "previous message" symptom: text, then the tool use it ended with.
    expect(
      claude(
        prompt,
        assistant('m1', { type: 'text', text: 'Running the full check.' }, 'tool_use'),
        assistant('m1', { type: 'tool_use' }, 'tool_use'),
        toolResult,
      ),
    ).toBe(false);
  });

  test('text from a message that stopped for a tool is still open', () => {
    expect(claude(prompt, assistant('m1', { type: 'text', text: 'Running it.' }, 'tool_use'))).toBe(
      false,
    );
  });

  test("a new prompt after the last turn's closing text is an open turn", () => {
    // Observed on a real worker: a turn answered without a tool has no
    // assistant entry at all when its stop lands, so the newest closing text
    // on disk is the previous turn's.
    const closed = assistant('m1', { type: 'text', text: 'first answer' }, 'end_turn');
    expect(claude(prompt, closed, metadata, prompt)).toBe(false);
  });

  test('a prompt recorded as human opens a turn too', () => {
    const human = JSON.stringify({ type: 'human', message: { role: 'user', content: 'again' } });
    const closed = assistant('m1', { type: 'text', text: 'first answer' }, 'end_turn');
    expect(claude(prompt, closed, human)).toBe(false);
  });

  test('no assistant entry yet is still open', () => {
    expect(claude(prompt)).toBe(false);
  });

  test('an assistant entry it cannot read never holds a read', () => {
    const unreadable = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 42, stop_reason: 'end_turn' },
    });
    expect(claude(prompt, unreadable)).toBe(true);
  });

  test('is total over malformed lines', () => {
    expect(
      claude('not json', prompt, '{', assistant('m', { type: 'text', text: 'done' }, 'end_turn')),
    ).toBe(true);
  });
});

function event(type: string): string {
  return JSON.stringify({ type: 'event_msg', payload: { type } });
}

const codex = (...lines: string[]): boolean => ended(CodexProvider, lines);

describe('CodexProvider.turnEnded', () => {
  test('task_complete after task_started closes the turn', () => {
    expect(codex(event('task_started'), event('token_count'), event('task_complete'))).toBe(true);
  });

  test('a turn that has started and not completed is open', () => {
    expect(
      codex(
        event('task_started'),
        event('task_complete'),
        event('task_started'),
        event('token_count'),
      ),
    ).toBe(false);
  });

  test('an aborted turn has ended', () => {
    expect(codex(event('task_started'), event('turn_aborted'))).toBe(true);
  });

  test('a rollout without turn markers never holds a read', () => {
    // Older rollouts predate the markers. Unable to prove the turn open, the
    // read must not wait on it.
    expect(codex(event('agent_message'))).toBe(true);
  });
});
