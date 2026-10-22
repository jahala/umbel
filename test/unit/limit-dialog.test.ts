import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { matchedLine } from '../../src/core/startup-dialogs.ts';

// ---------------------------------------------------------------------------
// umbel#75: a worker that hits its account's usage limit shows a dialog and
// waits there. Its Notification hook reads as an ordinary input prompt, so the
// wait's message carried "Claude is waiting for your input" and a conductor
// could not tell a quota from a question. The dialog's own line is the channel.
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, '../fixtures/limit');
const pane = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

const HIT = "You've hit your session limit · resets 4:30pm (Europe/Copenhagen)";
const USED = "You've used 94% of your session limit · resets 9:20pm";

describe('limitMatch', () => {
  test('names the limit dialog line a claude pane shows', () => {
    expect(matchedLine(pane('claude-session-limit.txt'), ClaudeProvider.limitMatch)).toBe(HIT);
    // The used-percent line is a warning claude shows while the worker keeps
    // working; status carries it as quota. Only a limit the worker has hit
    // blocks it, so only that line is the dialog.
    expect(matchedLine(`  ${USED}`, ClaudeProvider.limitMatch)).toBeUndefined();
  });

  // Wordings from real claude panes and transcripts on this machine. The CLI
  // composes them as `You've hit your <limit> · resets <time>` and
  // `You've used <n>% of your <limit> · resets <time>` (binary 2.1.308).
  test('matches the other limit wordings seen in real panes', () => {
    for (const line of pane('claude-limit-variants.txt').split('\n')) {
      const dialog = line.trim();
      if (dialog === '') continue;
      expect(matchedLine(line, ClaudeProvider.limitMatch)).toBe(dialog);
    }
  });

  test("the words in a worker's own output are not the dialog", () => {
    // A worker working on this code shows the phrase on its pane, in a diff or
    // a reply. Only a line that is the dialog is the dialog.
    expect(matchedLine(`⏺ ${HIT}`, ClaudeProvider.limitMatch)).toBeUndefined();
    expect(matchedLine(`Claude said: ${HIT}`, ClaudeProvider.limitMatch)).toBeUndefined();
    expect(
      matchedLine("You've hit your session limit is what the pane said", ClaudeProvider.limitMatch),
    ).toBeUndefined();
    expect(
      matchedLine(
        "Agent terminated early due to an API error: You've hit your weekly limit",
        ClaudeProvider.limitMatch,
      ),
    ).toBeUndefined();
  });

  test('a provider that shows no limit dialog names no line', () => {
    expect(CodexProvider.limitMatch).toBeUndefined();
    expect(matchedLine(`  ${HIT}`, undefined)).toBeUndefined();
  });
});
