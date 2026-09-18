import { readFile, stat } from 'node:fs/promises';
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

// A stop can land before the turn's final message does: claude fires its Stop
// hook first and writes the closing text 200-400ms later (umbel#86). A read
// taken within this window of the stop polls until the provider sees the turn
// end. Past the window, or with no stop at all, it reads once, so a read taken
// mid-turn is never held.
export const TURN_END_SETTLE_MS = 5000;
const TURN_END_POLL_MS = 100;

// Returns the transcript CONTENT as a string (NOT a path).
// - provider.exportTranscript defined → read sessionID from events/session-id,
//   run provider.exportTranscript(sid) via deps.exec, return stdout.
// - else → resolveJsonlPath(...) then read the file.
async function readOnce(opts: ResolveTranscriptOpts): Promise<string> {
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

// Reads the transcript, waiting out the gap between a recent stop and the
// turn's final message. `ended` is false when the window closed first: the
// content is the transcript as it stood, and may end before the handback.
export async function readTranscriptAtStop(
  opts: ResolveTranscriptOpts,
): Promise<{ content: string; ended: boolean }> {
  const d = { ...defaultDeps, ...opts.deps };
  const turnEnded = opts.provider.turnEnded;
  let content = await readOnce(opts);
  if (turnEnded === undefined) return { content, ended: true };

  let stoppedAt = 0;
  try {
    stoppedAt = (await stat(join(d.fs.eventsDir(opts.name, opts.env ?? {}), 'stop'))).mtimeMs;
  } catch {
    // No stop recorded: nothing to wait for.
  }
  const deadline = stoppedAt + TURN_END_SETTLE_MS;
  while (!turnEnded(content) && Date.now() < deadline) {
    await Bun.sleep(TURN_END_POLL_MS);
    content = await readOnce(opts);
  }
  return { content, ended: turnEnded(content) };
}

export async function resolveTranscriptContent(opts: ResolveTranscriptOpts): Promise<string> {
  return (await readTranscriptAtStop(opts)).content;
}
