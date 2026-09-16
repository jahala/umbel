// ---------------------------------------------------------------------------
// death — naming how a worker went, from what its pane recorded
// ---------------------------------------------------------------------------
//
// tmux records one of two things about a dead pane: the status the process
// returned, or the signal that killed it (never both, and neither when the
// session itself is gone). Callers see a sentence, not a field to interpret.

import { constants } from 'node:os';

export interface DeathCause {
  // False when the session is gone entirely — nothing was kept to read.
  exists: boolean;
  exitCode?: number;
  // As tmux names it — 'term' on macOS tmux 3.6, '15' on ubuntu's tmux 3.4.
  // No status accompanies one.
  signal?: string;
}

// tmux builds differ in how they name the signal: a lowercase name or the bare
// number. The number is the platform's, so the platform's table names it.
const SIGNAL_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(constants.signals).map(([name, number]) => [number, name]),
);

function signalName(signal: string): string {
  if (/^\d+$/.test(signal)) return SIGNAL_NAMES.get(Number(signal)) ?? `SIG${signal}`;
  const name = signal.toUpperCase();
  return name.startsWith('SIG') ? name : `SIG${name}`;
}

export function describeDeath(cause: DeathCause): string {
  const signal = cause.signal ?? '';
  if (signal !== '') {
    return `killed by ${signalName(signal)}`;
  }
  if (cause.exitCode !== undefined) return `process exited ${cause.exitCode}`;
  return cause.exists ? 'process exited, tmux recorded no status' : 'tmux session is gone';
}
