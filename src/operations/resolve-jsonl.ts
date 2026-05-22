import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionDeadError } from '../core/errors.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// Resolves a session's JSONL transcript path. The order of precedence:
//   1. session.jsonlPath in meta.json (already resolved on a prior call)
//   2. events/transcript-path (written by stop.sh from the lifecycle hook payload)
//   3. dir-snapshot discoverSessionJsonl (defensive fallback for fixtures /
//      older hook payloads that don't carry transcript_path)
//
// Successful resolution is persisted back to meta.json so subsequent calls
// are O(1).
//
// Throws SessionDeadError if all three strategies fail.
export interface ResolveJsonlOpts {
  name: string;
  cwd: string;
  sinceMs: number;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

export async function resolveJsonlPath(opts: ResolveJsonlOpts): Promise<string> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  // 1. Cached path in meta?
  const meta = await d.fs.readMeta(opts.name, env);
  if (meta.jsonlPath !== null && meta.jsonlPath.length > 0) {
    return meta.jsonlPath;
  }

  // 2. events/transcript-path from hook?
  const transcriptFile = join(d.fs.sessionDir(opts.name, env), 'events', 'transcript-path');
  let resolved = '';
  try {
    resolved = (await readFile(transcriptFile, 'utf8')).trim();
  } catch {
    // file missing → fall through to discovery
  }

  // 3. dir-snapshot fallback
  if (resolved === '') {
    try {
      resolved = await d.jsonl.discoverSessionJsonl({
        sessionName: opts.name,
        cwd: opts.cwd,
        sinceMs: opts.sinceMs,
      });
    } catch (err) {
      if (err instanceof SessionDeadError) {
        throw new SessionDeadError(opts.name, 'transcript path unresolved after Stop');
      }
      throw err;
    }
  }

  // Persist for next time (best-effort).
  try {
    await d.fs.writeMeta(opts.name, { ...meta, jsonlPath: resolved }, env);
  } catch {
    // not fatal — next call will re-resolve
  }

  return resolved;
}
