// ---------------------------------------------------------------------------
// death — naming how a worker went, from what its pane recorded
// ---------------------------------------------------------------------------
//
// tmux records one of two things about a dead pane: the status the process
// returned, or the signal that killed it (never both, and neither when the
// session itself is gone). Callers see a sentence, not a field to interpret.

export interface DeathCause {
  // False when the session is gone entirely — nothing was kept to read.
  exists: boolean;
  exitCode?: number;
  // As tmux names it: 'term', 'kill'. No status accompanies one.
  signal?: string;
}

export function describeDeath(cause: DeathCause): string {
  const signal = cause.signal ?? '';
  if (signal !== '') {
    const name = signal.toUpperCase();
    return `killed by ${name.startsWith('SIG') ? name : `SIG${name}`}`;
  }
  if (cause.exitCode !== undefined) return `process exited ${cause.exitCode}`;
  return cause.exists ? 'process exited, tmux recorded no status' : 'tmux session is gone';
}
