// A source the idle net watches, with when it last changed: a time in ms, or
// 'absent' (resolved, nothing on disk yet) or 'unresolved' (umbel could not
// find where it lives).
export interface IdleSource {
  name: string;
  lastChangeAt: number | 'absent' | 'unresolved';
}

// How long the worker has been still: the shortest stillness among the timed
// sources, since any of them moving means the worker is not idle. Undefined
// when no source carries a time.
export function stillForMs(sources: readonly IdleSource[], now: number): number | undefined {
  const stillness = sources.flatMap((s) =>
    typeof s.lastChangeAt === 'number' ? [Math.max(0, now - s.lastChangeAt)] : [],
  );
  return stillness.length === 0 ? undefined : Math.min(...stillness);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function describeSource(source: IdleSource, now: number): string {
  if (source.lastChangeAt === 'absent') return `${source.name} none`;
  if (source.lastChangeAt === 'unresolved') return `${source.name} unresolved`;
  return `${source.name} still ${seconds(Math.max(0, now - source.lastChangeAt))}`;
}

const ERROR_SCAN_LINES = 15;

// The newest of the pane's last non-empty lines matching a provider error
// pattern, trimmed. Older output has scrolled past and no longer describes the
// worker's state.
export function matchProviderError(pane: string, patterns: readonly RegExp[]): string | undefined {
  const lines = pane
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-ERROR_SCAN_LINES)
    .reverse();
  return lines.find((l) => patterns.some((p) => p.test(l)));
}

export function formatIdleMessage(sources: readonly IdleSource[], now: number): string {
  const idleFor = stillForMs(sources, now);
  const headline = idleFor === undefined ? 'idle' : `idle ${seconds(idleFor)}`;
  return `${headline}: ${sources.map((s) => describeSource(s, now)).join(' · ')}`;
}
