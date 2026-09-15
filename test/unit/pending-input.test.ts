import { describe, expect, test } from 'bun:test';
import { pendingInputLine } from '../../src/core/pending-input.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';

const match = CodexProvider.pendingInputMatch ?? /(?!)/;

describe('pendingInputLine', () => {
  test('codex placeholder in the input box, trailing blank rows below → that line', () => {
    const pane = [
      '› Ask Codex to do anything',
      'go',
      '› [Pasted Content 1125 chars]',
      '',
      '',
      '',
    ].join('\n');
    expect(pendingInputLine(pane, match)).toBe('› [Pasted Content 1125 chars]');
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
    expect(pendingInputLine(pane, match)).toBeUndefined();
  });

  test('pane without the placeholder → not pending', () => {
    expect(pendingInputLine('• Working\n', match)).toBeUndefined();
  });
});
