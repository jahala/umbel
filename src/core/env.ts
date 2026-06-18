import { EnvRefUnresolvedError } from './errors.ts';
import type { EnvValue } from './types.ts';

// A worker-env spec maps names to literal values OR {fromEnv} references.
export type WorkerEnvSpec = Record<string, EnvValue>;

// Resolve {fromEnv} references against a source env (the umbel server's
// process.env at the call site), returning a flat string env. PURE + total:
// throws EnvRefUnresolvedError when a referenced source var is unset, so an
// unresolved secret fails loudly instead of reaching the worker as "[object Object]".
export function resolveEnvRefs(
  spec: WorkerEnvSpec,
  source: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    const resolved = source[value.fromEnv];
    if (resolved === undefined) {
      throw new EnvRefUnresolvedError(key, value.fromEnv);
    }
    out[key] = resolved;
  }
  return out;
}
