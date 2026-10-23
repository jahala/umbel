import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionDeadError } from '../core/errors.ts';
import type { AgentProvider } from '../core/providers/types.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// Resolves a session's JSONL transcript path. The order of precedence:
//   1. events/transcript-path, the path the newest Stop hook recorded
//   2. session.jsonlPath in meta.json, cached by an earlier resolve
//   3. discovery of what the provider writes before its first hook fires:
//      the provider's transcriptSearch (codex rollouts), else claude's project
//      directory
//
// The hook outranks the cache because a worker's /clear or /new continues in a
// new transcript while meta still names the one before it (umbel#141).
//
// A successful resolve refreshes meta.json so a status call can answer without
// discovery.
//
// Throws SessionDeadError if all three strategies fail.
export interface ResolveJsonlOpts {
  name: string;
  cwd: string;
  sinceMs: number;
  provider: AgentProvider;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// The discovery step alone, without meta or the hook file. Shared by `read`,
// `actions`, status and wait's idle net, which each hold the pieces already.
export async function discoverTranscriptPath(opts: {
  name: string;
  cwd: string;
  sinceMs: number;
  provider: AgentProvider;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
  timeoutMs?: number;
}): Promise<string> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};
  const search = opts.provider.transcriptSearch?.({
    stateDir: d.fs.stateDir(env),
    cwd: opts.cwd,
  });

  if (search !== undefined) {
    return d.jsonl.discoverTranscript({
      sessionName: opts.name,
      cwd: opts.cwd,
      sinceMs: opts.sinceMs,
      search,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  return d.jsonl.discoverSessionJsonl({
    sessionName: opts.name,
    cwd: opts.cwd,
    sinceMs: opts.sinceMs,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

async function hookedTranscriptPath(
  name: string,
  env: Record<string, string | undefined>,
  d: Deps,
): Promise<string> {
  try {
    return (await readFile(join(d.fs.eventsDir(name, env), 'transcript-path'), 'utf8')).trim();
  } catch {
    return '';
  }
}

// The path known from state alone, without discovery. The hook's newest record
// wins over the one meta cached before it, so a transcript that changed under
// the worker is never missed. Reads, actions, status and wait share this, so
// the precedence has one home.
export async function knownTranscriptPath(
  name: string,
  cached: string | null,
  env: Record<string, string | undefined>,
  d: Deps,
): Promise<string> {
  const hooked = await hookedTranscriptPath(name, env, d);
  if (hooked !== '') return hooked;
  return cached ?? '';
}

export async function resolveJsonlPath(opts: ResolveJsonlOpts): Promise<string> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  const meta = await d.fs.readMeta(opts.name, env);
  let resolved = await knownTranscriptPath(opts.name, meta.jsonlPath, env, d);

  if (resolved === '') {
    try {
      resolved = await discoverTranscriptPath({
        name: opts.name,
        cwd: opts.cwd,
        sinceMs: opts.sinceMs,
        provider: opts.provider,
        env,
        ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
      });
    } catch (err) {
      if (err instanceof SessionDeadError) {
        throw new SessionDeadError(opts.name, 'transcript path unresolved after Stop');
      }
      throw err;
    }
  }

  // Refresh the cache when the hook named a newer transcript (best-effort).
  if (resolved !== '' && resolved !== meta.jsonlPath) {
    try {
      await d.fs.writeMeta(opts.name, { ...meta, jsonlPath: resolved }, env);
    } catch {
      // not fatal; the hook file remains the source
    }
  }

  return resolved;
}
