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

// Pure: given the current pane text, the provider's dialog specs, and the set
// of dialog indices already dismissed this spawn, return the index of the
// first not-yet-fired dialog whose matcher hits the pane — or null if none.
//
// Total. No I/O. Lower indices win so a multi-dialog sequence is dismissed in
// declared order.
export function nextStartupDialog(
  pane: string,
  dialogs: readonly StartupDialog[],
  fired: ReadonlySet<number>,
): number | null {
  for (let i = 0; i < dialogs.length; i++) {
    if (fired.has(i)) continue;
    const dialog = dialogs[i];
    if (dialog !== undefined && dialog.match.test(pane)) {
      return i;
    }
  }
  return null;
}
