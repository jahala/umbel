import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { GeminiProvider } from '../../src/core/providers/gemini.ts';
import { OpenCodeProvider } from '../../src/core/providers/opencode.ts';
import { matchedLine } from '../../src/core/startup-dialogs.ts';

// ---------------------------------------------------------------------------
// umbel#105: a CLI with no credentials opens on its sign-in screen and stays
// there until a person acts. Each provider names that screen. The panes below
// are the installed binaries', captured with an empty config home.
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, '../fixtures');
const pane = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

describe('signInMatch', () => {
  test.each([
    [
      'claude, first-run setup',
      ClaudeProvider,
      'sign-in/claude-2.1.276-theme.txt',
      'Choose the text style that looks best with your terminal',
    ],
    ['claude', ClaudeProvider, 'sign-in/claude-2.1.276-login.txt', 'Select login method:'],
    [
      'codex',
      CodexProvider,
      'sign-in/codex-0.154.0-sign-in.txt',
      'or connect an API key for usage-based billing',
    ],
    [
      'gemini',
      GeminiProvider,
      'sign-in/gemini-0.46.0-sign-in.txt',
      'How would you like to authenticate for this project?',
    ],
  ])('names the line of %s', (_, provider, file, line) => {
    expect(matchedLine(pane(file), provider.signInMatch)).toBe(line);
  });

  test('a CLI that started is not at its sign-in screen', () => {
    expect(matchedLine(pane('codex-0.154-startup.txt'), CodexProvider.signInMatch)).toBeUndefined();
  });

  test("the phrase in a worker's own output is not the sign-in screen", () => {
    // A worker working on this code shows the phrase on its pane, in a diff or
    // a reply. Only a line that is the phrase alone is the screen.
    const worker = [
      '  12 +  signInMatch: /^\\s*Select login method:\\s*$/m,',
      '⏺ The claude menu reads "Select login method:" when it has no credentials.',
    ].join('\n');
    expect(matchedLine(worker, ClaudeProvider.signInMatch)).toBeUndefined();
  });

  test('opencode has no sign-in screen', () => {
    expect(OpenCodeProvider.signInMatch).toBeUndefined();
    expect(matchedLine('anything', undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// umbel#166: gemini 0.46 shows the same authentication menu on any startup
// authentication failure, with the real error in a row of that panel. The menu
// alone says "not signed in"; the row says why.
// ---------------------------------------------------------------------------
const GEMINI_AUTH_FAILURE =
  'Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for ' +
  'individuals. To continue using Gemini, please migrate to the Antigravity suite of products: ' +
  'https://antigravity.google';

describe('the cause beside a sign-in screen', () => {
  test('gemini carries the failure its panel shows', () => {
    expect(GeminiProvider.signInCause?.(pane('sign-in/gemini-0.46.0-sign-in-error.txt'))).toBe(
      GEMINI_AUTH_FAILURE,
    );
  });

  test('gemini with no credentials names no cause', () => {
    // The panel's same row reads "No authentication method selected." there,
    // which is the state the refusal already reports.
    expect(GeminiProvider.signInCause?.(pane('sign-in/gemini-0.46.0-sign-in.txt'))).toBeUndefined();
  });

  test('a working pane names no cause', () => {
    expect(GeminiProvider.signInCause?.('✦ Reading the repository')).toBeUndefined();
  });
});
