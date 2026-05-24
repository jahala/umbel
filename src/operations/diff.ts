import { unifiedDiff } from '../core/diff.ts';
import { RctrlUsageError } from '../core/errors.ts';
import { getProvider } from '../core/providers/registry.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// diff — return a unified text diff between two turns of a session.
//
// Default: latest turn vs the one immediately before it (the common case in
// review→fix loops where the orchestrator wants the delta between consecutive
// turns, not the full new transcript).
//
// `from` and `to` are turn indices. Negative indices count from the end
// (-1 = latest). Out-of-range indices throw RctrlUsageError.
// ---------------------------------------------------------------------------

export interface DiffOpts {
  name: string;
  from?: number;
  to?: number;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

export async function diff(opts: DiffOpts): Promise<string> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  const session = await d.fs.readMeta(opts.name, env);
  const jsonlPath = session.jsonlPath;
  if (jsonlPath === null) return '(no transcript yet)';

  const provider = getProvider(session.provider);
  if (provider.extractTurns === undefined) {
    return `(turn extraction not implemented for provider: ${session.provider})`;
  }

  const content = await Bun.file(jsonlPath).text();
  const turns = provider.extractTurns(content);

  if (turns.length === 0) return '(no completed turns yet)';
  if (turns.length === 1 && opts.from === undefined && opts.to === undefined) {
    return '(only one turn so far — nothing to diff against)';
  }

  const toIdx = resolveIndex(opts.to, turns.length, turns.length - 1);
  const fromIdx = resolveIndex(opts.from, turns.length, toIdx - 1);

  if (fromIdx < 0 || fromIdx >= turns.length) {
    throw new RctrlUsageError(
      `diff: from index ${opts.from ?? fromIdx} out of range (have ${turns.length} turns)`,
    );
  }
  if (toIdx < 0 || toIdx >= turns.length) {
    throw new RctrlUsageError(
      `diff: to index ${opts.to ?? toIdx} out of range (have ${turns.length} turns)`,
    );
  }

  const fromTurn = turns[fromIdx];
  const toTurn = turns[toIdx];
  if (fromTurn === undefined || toTurn === undefined) {
    return '(turn lookup failed)';
  }

  if (fromTurn.text === toTurn.text) {
    return `(no changes between turn ${fromIdx} and turn ${toIdx})`;
  }

  return unifiedDiff(fromTurn.text, toTurn.text, {
    aLabel: `turn ${fromIdx}`,
    bLabel: `turn ${toIdx}`,
  });
}

// Resolve a possibly-negative index against the turn array length. Negative
// indices count from the end: -1 = last, -2 = second-to-last, etc.
function resolveIndex(value: number | undefined, length: number, fallback: number): number {
  if (value === undefined) return fallback;
  return value < 0 ? length + value : value;
}
