// The input box sits at the bottom of a TUI, under at most a footer or two, so
// only the last few non-empty lines can hold a still-pending prompt. A
// placeholder further up is conversation history.
const PENDING_SCAN_LINES = 6;

export function isInputPending(pane: string, match: RegExp): boolean {
  return pane
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-PENDING_SCAN_LINES)
    .some((l) => match.test(l));
}
