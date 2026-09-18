// ---------------------------------------------------------------------------
// startup-dialogs — declarative provider startup-dialog dismissal (pure core)
// ---------------------------------------------------------------------------
//
// Some provider TUIs block on interactive dialogs on first launch in a fresh
// cwd (Claude's workspace-trust prompt; Codex's directory-trust + hook-review
// prompts). umbel auto-dismisses them by watching the tmux pane and sending
// the keystrokes a human would. Each provider declares its dialogs here; the
// generic poll/dismiss loop lives in the operations layer (it does the I/O).
//
// `keys` are tmux key names passed to `send-keys` (e.g. 'Enter', 'Down',
// 'Escape') — NOT literal prompt text. Order matters: ['Down', 'Enter']
// moves the selection down one then confirms.

export interface StartupDialog {
  // Matched against the captured pane text. Use a stable substring of the
  // dialog so wording tweaks elsewhere don't break the match.
  readonly match: RegExp;
  // tmux key names sent in order to dismiss the dialog.
  readonly keys: readonly string[];
}

// PURE. The line of the provider's sign-in screen on this pane, trimmed of
// whitespace and box borders, or undefined when the screen is not showing.
// `match` is a whole-line pattern (`^…$` with the m flag): a worker's own output
// can hold the same words, in a diff or a reply, but never alone on a line.
export function signInLine(pane: string, match: RegExp | undefined): string | undefined {
  if (match === undefined) return undefined;
  const hit = pane.match(match);
  return hit === null ? undefined : hit[0].replace(/^[\s│]+|[\s│]+$/g, '');
}

// Pure: given the current pane text, the provider's dialog specs, and the set
// of dialog indices to skip (those whose keys have been re-sent to the attempt
// limit without the dialog clearing), return the index of the first remaining
// dialog whose matcher hits the pane — or null if none.
//
// Total. No I/O. Lower indices win so a multi-dialog sequence is dismissed in
// declared order.
export function nextStartupDialog(
  pane: string,
  dialogs: readonly StartupDialog[],
  skip: ReadonlySet<number>,
): number | null {
  for (let i = 0; i < dialogs.length; i++) {
    if (skip.has(i)) continue;
    const dialog = dialogs[i];
    if (dialog !== undefined && dialog.match.test(pane)) {
      return i;
    }
  }
  return null;
}
