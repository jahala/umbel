import { describe, expect, test } from 'bun:test';
import { isInputPending } from '../../src/core/pending-input.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';

const match = CodexProvider.pendingInputMatch ?? /(?!)/;

describe('isInputPending', () => {
  test('codex placeholder in the input box, trailing blank rows below → pending', () => {
    const pane = [
      '› Ask Codex to do anything',
      'go',
      '› [Pasted Content 1125 chars]',
      '',
      '',
      '',
    ].join('\n');
    expect(isInputPending(pane, match)).toBe(true);
  });

  test('placeholder above a started turn is history → not pending', () => {
    const pane = [
      '› [Pasted Content 1125 chars]',
      '• Working (3s • esc to interrupt)',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      '› Ask Codex to do anything',
      '? for shortcuts',
    ].join('\n');
    expect(isInputPending(pane, match)).toBe(false);
  });

  test('pane without the placeholder → not pending', () => {
    expect(isInputPending('• Working\n', match)).toBe(false);
  });
});
