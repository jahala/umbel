import { matchedLine } from './startup-dialogs.ts';

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

// A provider's error line may wrap onto a few more rows on a narrow pane. A
// bound keeps an unrelated indented row below it from being read as part of it.
const ERROR_CONTINUATION_ROWS = 3;

const ends = (line: string): string => line.replace(/^[\s│]+|[\s│]+$/g, '');
const BOX_DRAWING = /[╭╮╰╯│─]/;

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

// The provider's own error line on the visible screen, its marker and box
// borders trimmed, with a wrapped continuation joined on. Unlike
// matchProviderError this reads the whole screen rather than its last rows: a
// worker that failed a turn keeps the error a few rows above its input box.
// Patterns are matched per line, so each provider anchors its own marker
// (claude: `⏺ API Error:`) rather than relying on this reader.
export function providerErrorLine(pane: string, patterns: readonly RegExp[]): string | undefined {
  if (patterns.length === 0) return undefined;
  const lines = pane.split('\n');
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = ends(lines[i] ?? '');
    if (patterns.some((p) => p.test(line))) at = i;
  }
  if (at === -1) return undefined;
  // Anything the CLI printed after the error (its message marker, ⏺) means the
  // worker carried on: the error is history, not why it waits now.
  if (lines.slice(at + 1).some((l) => ends(l).startsWith('⏺'))) return undefined;
  const parts = [ends(lines[at] ?? '').replace(/^⏺\s*/, '')];
  for (let i = at + 1; i < lines.length && parts.length - 1 < ERROR_CONTINUATION_ROWS; i++) {
    const row = lines[i] ?? '';
    // A wrapped row is indented prose. A blank row, a box edge or anything
    // unindented is the next thing on the screen, not this line.
    if (row.trim() === '' || BOX_DRAWING.test(row) || !/^\s/.test(row)) break;
    parts.push(row.trim());
  }
  return parts.join(' ');
}

// What a pane that is waiting on input is actually saying: the provider's
// usage-limit dialog first (it carries the reset time), then its own error line
// (the provider refused the turn and the CLI fell back to its idle prompt),
// then the hook's message. The caller reads the fresh screen, since a limit or
// error from earlier stays in scrollback and would label a later question
// (umbel#75, umbel#129).
export function inputMessage(
  pane: string,
  provider: { readonly limitMatch?: RegExp; readonly errorMatch?: readonly RegExp[] } | undefined,
  fallback: string | undefined,
): string | undefined {
  const limit = matchedLine(pane, provider?.limitMatch);
  if (limit !== undefined) return limit;
  return providerErrorLine(pane, provider?.errorMatch ?? []) ?? fallback;
}

export function formatIdleMessage(sources: readonly IdleSource[], now: number): string {
  const idleFor = stillForMs(sources, now);
  const headline = idleFor === undefined ? 'idle' : `idle ${seconds(idleFor)}`;
  return `${headline}: ${sources.map((s) => describeSource(s, now)).join(' · ')}`;
}
