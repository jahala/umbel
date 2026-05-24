// ---------------------------------------------------------------------------
// Myers line-level diff → unified diff format (pure, no dependencies)
// ---------------------------------------------------------------------------
//
// Returns a string in the same shape that `diff -u` produces:
//
//   --- a/<aLabel>
//   +++ b/<bLabel>
//   @@ -1,3 +1,3 @@
//    unchanged
//   -removed
//   +added
//    unchanged
//
// Empty string is returned when inputs are identical (or both empty).
// Pure & total — no I/O, no exceptions.

export interface UnifiedDiffOpts {
  contextLines?: number; // default: 3
  aLabel?: string; // default: 'a'
  bLabel?: string; // default: 'b'
}

export function unifiedDiff(a: string, b: string, opts: UnifiedDiffOpts = {}): string {
  if (a === b) return '';

  const contextLines = opts.contextLines ?? 3;
  const aLabel = opts.aLabel ?? 'a';
  const bLabel = opts.bLabel ?? 'b';

  const aLines = a.length === 0 ? [] : a.split('\n');
  const bLines = b.length === 0 ? [] : b.split('\n');

  const ops = myersDiff(aLines, bLines);
  const hunks = collectHunks(ops, contextLines);
  if (hunks.length === 0) return '';

  const out: string[] = [];
  out.push(`--- a/${aLabel}`);
  out.push(`+++ b/${bLabel}`);
  for (const hunk of hunks) {
    // Unified-diff convention: ranges are 1-indexed, but an empty range
    // (length 0) starts at 0, not 1. Matches `git diff` / GNU diff output.
    const aStart = hunk.aLen === 0 ? 0 : hunk.aStart + 1;
    const bStart = hunk.bLen === 0 ? 0 : hunk.bStart + 1;
    out.push(`@@ -${aStart},${hunk.aLen} +${bStart},${hunk.bLen} @@`);
    for (const line of hunk.lines) out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Myers shortest-edit-script — operates on line arrays
// ---------------------------------------------------------------------------

type Op = { kind: 'eq' | 'add' | 'del'; line: string };

function myersDiff(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line) => ({ kind: 'add', line }));
  if (m === 0) return a.map((line) => ({ kind: 'del', line }));

  // Standard Myers O((n+m)d) algorithm — store the V trace per d so we can
  // walk back to reconstruct the path. Reasonable for our scale (turns are
  // up to a few thousand lines each).
  const max = n + m;
  const v: Record<number, number> = { 1: 0 };
  const trace: Array<Record<number, number>> = [];

  let foundD = -1;
  outer: for (let d = 0; d <= max; d++) {
    const snapshot: Record<number, number> = {};
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      const kMinus1 = v[k - 1];
      const kPlus1 = v[k + 1];
      const goDown =
        k === -d || (k !== d && (kMinus1 === undefined || (kPlus1 ?? -1) > (kMinus1 ?? -1)));
      if (goDown) {
        x = kPlus1 ?? 0;
      } else {
        x = (kMinus1 ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k] = x;
      snapshot[k] = x;
      if (x >= n && y >= m) {
        trace.push(snapshot);
        foundD = d;
        break outer;
      }
    }
    trace.push(snapshot);
  }

  // Walk back through the trace to reconstruct the edit script.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const snap = trace[d - 1];
    if (snap === undefined) break;
    const k = x - y;
    const kMinus1 = snap[k - 1];
    const kPlus1 = snap[k + 1];
    const goDown =
      k === -d || (k !== d && (kMinus1 === undefined || (kPlus1 ?? -1) > (kMinus1 ?? -1)));
    const prevK = goDown ? k + 1 : k - 1;
    const prevX = snap[prevK];
    if (prevX === undefined) break;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      const line = a[x - 1];
      if (line !== undefined) ops.push({ kind: 'eq', line });
      x--;
      y--;
    }
    if (d > 0) {
      if (goDown) {
        const line = b[y - 1];
        if (line !== undefined) ops.push({ kind: 'add', line });
        y--;
      } else {
        const line = a[x - 1];
        if (line !== undefined) ops.push({ kind: 'del', line });
        x--;
      }
    }
  }
  while (x > 0 && y > 0) {
    const line = a[x - 1];
    if (line !== undefined) ops.push({ kind: 'eq', line });
    x--;
    y--;
  }
  while (x > 0) {
    const line = a[x - 1];
    if (line !== undefined) ops.push({ kind: 'del', line });
    x--;
  }
  while (y > 0) {
    const line = b[y - 1];
    if (line !== undefined) ops.push({ kind: 'add', line });
    y--;
  }

  ops.reverse();
  return ops;
}

// ---------------------------------------------------------------------------
// Group ops into hunks with surrounding context
// ---------------------------------------------------------------------------

interface Hunk {
  aStart: number; // 0-indexed line in a where this hunk begins
  bStart: number;
  aLen: number; // number of a-lines (context + del) in this hunk
  bLen: number; // number of b-lines (context + add) in this hunk
  lines: string[]; // formatted lines with ' ' / '-' / '+' prefix
}

// Two-phase grouping. Phase 1 walks the ops list once, identifying contiguous
// runs of non-eq ops (each run = one block of changes). Phase 2 groups runs
// that are separated by ≤ 2*context eq lines into a single hunk (so the
// adjacent runs share context); larger gaps become hunk boundaries. This
// avoids the off-by-one trimming bugs that plague the single-pass approach
// (especially at context=0).
interface ChangeRun {
  start: number; // index in ops where this run of non-eq ops begins
  end: number; // exclusive — first index after the run
  aAtStart: number; // a-line counter immediately before this run
  bAtStart: number; // b-line counter immediately before this run
}

function collectHunks(ops: readonly Op[], context: number): Hunk[] {
  // Phase 1: enumerate change runs.
  const runs: ChangeRun[] = [];
  {
    let i = 0;
    let aIdx = 0;
    let bIdx = 0;
    while (i < ops.length) {
      // Skip eq.
      while (i < ops.length && ops[i]?.kind === 'eq') {
        i++;
        aIdx++;
        bIdx++;
      }
      if (i >= ops.length) break;
      const start = i;
      const aAtStart = aIdx;
      const bAtStart = bIdx;
      while (i < ops.length) {
        const op = ops[i];
        if (op === undefined || op.kind === 'eq') break;
        if (op.kind === 'del') aIdx++;
        else bIdx++;
        i++;
      }
      runs.push({ start, end: i, aAtStart, bAtStart });
    }
  }
  if (runs.length === 0) return [];

  // Phase 2: group runs separated by ≤ 2*context eq ops into single hunks.
  const hunks: Hunk[] = [];
  let groupStart = 0;
  for (let g = 1; g <= runs.length; g++) {
    const isBoundary =
      g === runs.length ||
      (() => {
        const prevEnd = runs[g - 1]?.end ?? 0;
        const nextStart = runs[g]?.start ?? 0;
        return nextStart - prevEnd > 2 * context;
      })();
    if (!isBoundary) continue;

    const first = runs[groupStart];
    const last = runs[g - 1];
    if (first === undefined || last === undefined) continue;

    // Leading context: up to `context` eq ops before first.start.
    const leadLen = Math.min(context, first.start);
    const hunkOpStart = first.start - leadLen;

    // Trailing context: up to `context` eq ops after last.end.
    let trailLen = 0;
    while (
      trailLen < context &&
      last.end + trailLen < ops.length &&
      ops[last.end + trailLen]?.kind === 'eq'
    ) {
      trailLen++;
    }
    const hunkOpEnd = last.end + trailLen;

    // a/b-line start = first run's a/b counter, minus the eq ops we walked
    // back for leading context (each eq op contributes 1 to both a and b).
    const aHunkStart = first.aAtStart - leadLen;
    const bHunkStart = first.bAtStart - leadLen;

    const lines: string[] = [];
    let aLen = 0;
    let bLen = 0;
    for (let p = hunkOpStart; p < hunkOpEnd; p++) {
      const op = ops[p];
      if (op === undefined) continue;
      if (op.kind === 'eq') {
        lines.push(` ${op.line}`);
        aLen++;
        bLen++;
      } else if (op.kind === 'del') {
        lines.push(`-${op.line}`);
        aLen++;
      } else {
        lines.push(`+${op.line}`);
        bLen++;
      }
    }

    hunks.push({ aStart: aHunkStart, bStart: bHunkStart, aLen, bLen, lines });
    groupStart = g;
  }

  return hunks;
}
