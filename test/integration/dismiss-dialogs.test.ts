import { describe, expect, test } from 'bun:test';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { dismissStartupDialogs } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// dismissStartupDialogs — drives the poll/dismiss loop with a scripted fake
// tmux. capturePane returns a sequence of panes (dialog 1 → dialog 2 → main
// UI); sendKeys records what was sent. Verifies the real CodexProvider specs
// produce the correct keystroke sequence (Enter, then Down+Enter).
// ---------------------------------------------------------------------------

function makeFakeTmux(panes: string[]) {
  const sent: string[][] = [];
  let call = 0;
  return {
    sent,
    tmux: {
      // Return each scripted pane once, then repeat the last one.
      capturePane: async (_name: string, _lines?: number): Promise<string> => {
        const pane = panes[Math.min(call, panes.length - 1)] ?? '';
        call++;
        return pane;
      },
      sendKeys: async (_name: string, keys: readonly string[]): Promise<void> => {
        sent.push([...keys]);
      },
    },
  };
}

describe('dismissStartupDialogs (CodexProvider specs)', () => {
  test('dismisses both codex dialogs with Enter then Down+Enter', async () => {
    const { sent, tmux } = makeFakeTmux([
      'Do you trust the contents of this directory?\n1. Yes, continue\n2. No, quit',
      'Hooks need review\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting',
      '>_ OpenAI Codex (v0.133.0)\ndirectory: /tmp/x\nImplement {feature}',
    ]);

    await dismissStartupDialogs(
      { tmux } as never,
      'sess',
      CodexProvider.startupDialogs ?? [],
      CodexProvider.readyMatch,
    );

    expect(sent).toEqual([['Enter'], ['Down', 'Enter']]);
  });

  test('full 3-dialog sequence (update → trust → hooks) → Skip, Enter, Trust-all', async () => {
    const { sent, tmux } = makeFakeTmux([
      'Update available! 0.133.0 -> 0.135.0\n1. Update now\n2. Skip\n3. Skip until next version',
      'Do you trust the contents of this directory?\n1. Yes, continue\n2. No, quit',
      'Hooks need review\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting',
      '>_ OpenAI Codex (v0.133.0)\nImplement {feature}',
    ]);

    await dismissStartupDialogs(
      { tmux } as never,
      'sess',
      CodexProvider.startupDialogs ?? [],
      CodexProvider.readyMatch,
    );

    // Update → Skip (Down,Enter); Trust → Enter; Hooks → Trust-all (Down,Enter).
    // Critically, the FIRST keystroke is NOT a bare Enter (which would hit the
    // dangerous "Update now" default).
    expect(sent).toEqual([['Down', 'Enter'], ['Enter'], ['Down', 'Enter']]);
  });

  test('already-trusted cwd (no dialogs, straight to main UI) sends nothing', async () => {
    const { sent, tmux } = makeFakeTmux([
      '>_ OpenAI Codex (v0.133.0)\ndirectory: /tmp/x\nImplement {feature}',
    ]);

    await dismissStartupDialogs(
      { tmux } as never,
      'sess',
      CodexProvider.startupDialogs ?? [],
      CodexProvider.readyMatch,
    );

    expect(sent).toEqual([]);
  });

  test('only the first dialog appears (second never shown) → only Enter sent', async () => {
    // Dir-trust dialog, then straight to main UI (e.g. no hooks configured).
    const { sent, tmux } = makeFakeTmux([
      'Do you trust the contents of this directory?\n1. Yes, continue',
      '>_ OpenAI Codex\nImplement {feature}',
    ]);

    await dismissStartupDialogs(
      { tmux } as never,
      'sess',
      CodexProvider.startupDialogs ?? [],
      CodexProvider.readyMatch,
    );

    expect(sent).toEqual([['Enter']]);
  });

  test('empty dialog list is a no-op', async () => {
    const { sent, tmux } = makeFakeTmux(['anything']);
    await dismissStartupDialogs({ tmux } as never, 'sess', [], undefined);
    expect(sent).toEqual([]);
  });
});
