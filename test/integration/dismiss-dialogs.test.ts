import { describe, expect, test } from 'bun:test';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { GeminiProvider } from '../../src/core/providers/gemini.ts';
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

describe('dismissStartupDialogs (GeminiProvider specs)', () => {
  test('dismisses the gemini folder-trust dialog with Enter', async () => {
    // Real gemini 0.44 pane text (welcome banner co-renders above the dialog).
    const { sent, tmux } = makeFakeTmux([
      "Gemini CLI v0.44.0\nTips for getting started\n│ Do you trust the files in this folder? │\n● 1. Trust folder\n  2. Trust parent folder\n  3. Don't trust",
      // After Enter, gemini advances (next prompt / main UI); single dialog →
      // loop exits as soon as it fires regardless.
      'Gemini CLI v0.44.0\n> Type your message',
    ]);

    await dismissStartupDialogs(
      { tmux } as never,
      'sess',
      GeminiProvider.startupDialogs ?? [],
      GeminiProvider.readyMatch,
    );

    expect(sent).toEqual([['Enter']]);
  });

  test('gemini banner alone (no trust dialog) sends nothing', async () => {
    // Already-trusted: banner present but no trust prompt. Must NOT mistake
    // the banner for a dialog (regression guard for the deliberately-dropped
    // banner readyMatch). With no readyMatch + no matching dialog the loop
    // polls to its internal timeout (~8s) before returning — hence the
    // explicit per-test timeout below. (Follow-up: add a verified authed
    // main-UI readyMatch to make this fast.)
    const { sent, tmux } = makeFakeTmux([
      'Gemini CLI v0.44.0\nTips for getting started\n> Type your message',
    ]);

    await dismissStartupDialogs(
      { tmux } as never,
      'sess',
      GeminiProvider.startupDialogs ?? [],
      GeminiProvider.readyMatch,
    );

    expect(sent).toEqual([]);
  }, 12_000);
});

describe('dismissStartupDialogs (dialog-less warm-up via readyMatch)', () => {
  // opencode has no startup dialogs but DOES have a readyMatch. The loop must
  // poll until the UI renders (warm-up) so the first send doesn't race boot —
  // returning immediately on empty dialogs (the old behaviour) dropped the
  // first prompt into a still-booting TUI.
  test('empty dialogs + readyMatch: polls until ready, sends nothing', async () => {
    let captures = 0;
    const panes = ['booting…', 'booting…', 'Ask anything...'];
    let sentCount = 0;
    const tmux = {
      capturePane: async () => panes[Math.min(captures++, panes.length - 1)] ?? '',
      sendKeys: async () => {
        sentCount++;
      },
    };
    await dismissStartupDialogs({ tmux } as never, 'sess', [], /Ask anything\.\.\.|Build · /);
    expect(captures).toBeGreaterThan(1); // polled — did NOT return immediately
    expect(sentCount).toBe(0); // no dialogs → no keystrokes
  });
});

// ---------------------------------------------------------------------------
// Claude's dialogs. Pane text below is verbatim from Claude Code 2.1.261,
// captured 2026-09-05 by launching the real binary in an untrusted clone.
// The keys matter: pressing Enter on the trust prompt was tested against the
// real binary and it EXITS — a bare Enter kills the worker.
// ---------------------------------------------------------------------------

const TRUST_ON_NO = [
  ' Accessing workspace:',
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const TRUST_ON_YES = [
  ' Quick safety check: Is this a project you created or one you trust?',
  '   No, exit',
  ' ❯ Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const EXTERNAL_IMPORTS = [
  '  Allow external CLAUDE.md file imports?',
  "  This project's CLAUDE.md imports files outside the current working directory.",
  '  ❯ No, disable external imports',
  '    Yes, allow external imports',
  '  Enter to confirm · Esc to cancel',
].join('\n');

const CLAUDE_MAIN_UI = ['❯ Try "fix lint errors"', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join(
  '\n',
);

function claudeDismiss(panes: string[]): Promise<string[][]> {
  const { sent, tmux } = makeFakeTmux(panes);
  return dismissStartupDialogs(
    { tmux } as never,
    'sess',
    ClaudeProvider.startupDialogs ?? [],
    ClaudeProvider.readyMatch,
  ).then(() => sent);
}

describe('dismissStartupDialogs (ClaudeProvider specs)', () => {
  test('trust prompt: moves off the "No, exit" default before confirming', async () => {
    expect(await claudeDismiss([TRUST_ON_NO, CLAUDE_MAIN_UI])).toEqual([['Down', 'Enter']]);
  });

  test('trust prompt with the cursor already on Yes: confirms in place', async () => {
    // Reachable when a retry lands after Down moved the selection. Sending
    // Down again here would walk back onto "No, exit" and kill the worker.
    expect(await claudeDismiss([TRUST_ON_YES, CLAUDE_MAIN_UI])).toEqual([['Enter']]);
  });

  test('external CLAUDE.md imports prompt is dismissed on its safe default', async () => {
    expect(await claudeDismiss([EXTERNAL_IMPORTS, CLAUDE_MAIN_UI])).toEqual([['Enter']]);
  });

  test('already-trusted cwd sends nothing', async () => {
    expect(await claudeDismiss([CLAUDE_MAIN_UI])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Swallowed keystrokes. A TUI that has rendered its dialog but is not yet
// accepting input drops the first keypress. Firing once and moving on leaves
// the worker parked on the dialog until the wait deadline — observed against
// the real binary, where the worker sat on the trust prompt indefinitely.
// ---------------------------------------------------------------------------

function makeSwallowingTmux(dialogPane: string, readyPane: string, swallow: number) {
  const sent: string[][] = [];
  return {
    sent,
    tmux: {
      capturePane: async (): Promise<string> => (sent.length > swallow ? readyPane : dialogPane),
      sendKeys: async (_name: string, keys: readonly string[]): Promise<void> => {
        sent.push([...keys]);
      },
    },
  };
}

describe('dismissStartupDialogs (swallowed keystrokes)', () => {
  test('re-sends while the dialog is still on the pane', async () => {
    const { sent, tmux } = makeSwallowingTmux(TRUST_ON_NO, CLAUDE_MAIN_UI, 1);

    await dismissStartupDialogs(
      { tmux } as never,
      'sess',
      ClaudeProvider.startupDialogs ?? [],
      ClaudeProvider.readyMatch,
    );

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((k) => k.join() === 'Down,Enter')).toBe(true);
  });

  test('gives up rather than typing forever at a dialog that never clears', async () => {
    // Guard, not a spec: retrying is what makes unbounded key-spam into a live
    // agent possible, so the bound is the thing that must not regress.
    const { sent, tmux } = makeSwallowingTmux(TRUST_ON_NO, CLAUDE_MAIN_UI, Number.MAX_SAFE_INTEGER);

    await dismissStartupDialogs(
      { tmux } as never,
      'sess',
      ClaudeProvider.startupDialogs ?? [],
      ClaudeProvider.readyMatch,
    );

    expect(sent.length).toBeLessThanOrEqual(3);
  }, 12_000);
});
