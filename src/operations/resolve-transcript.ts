import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionDeadError } from '../core/errors.ts';
import type { AgentProvider } from '../core/providers/types.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';
import { resolveJsonlPath } from './resolve-jsonl.ts';

export interface ResolveTranscriptOpts {
  name: string;
  cwd: string;
  sinceMs: number;
  provider: AgentProvider; // caller already resolves this via getProvider
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// Returns the transcript CONTENT as a string (NOT a path).
// - provider.exportTranscript defined → read sessionID from events/session-id,
//   run provider.exportTranscript(sid) via deps.exec, return stdout.
// - else → resolveJsonlPath(...) then read the file (current behavior).
export async function resolveTranscriptContent(opts: ResolveTranscriptOpts): Promise<string> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  if (opts.provider.exportTranscript !== undefined) {
    // Command branch: run the provider's export command.
    const sessionIdFile = join(d.fs.eventsDir(opts.name, env), 'session-id');
    let sid = '';
    try {
      sid = (await readFile(sessionIdFile, 'utf8')).trim();
    } catch {
      // file missing — fall through to error below
    }
    if (sid.length === 0) {
      throw new SessionDeadError(opts.name, 'no session-id for export');
    }
    return await d.exec.run(opts.provider.exportTranscript(sid), { cwd: opts.cwd });
  }

  // File branch: resolve the JSONL path then read it.
  // Throws SessionDeadError if all resolution strategies fail (callers handle it).
  const path = await resolveJsonlPath({
    name: opts.name,
    cwd: opts.cwd,
    sinceMs: opts.sinceMs,
    env,
    ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
  });
  if (path.length === 0) return '';
  return await readFile(path, 'utf8');
}
