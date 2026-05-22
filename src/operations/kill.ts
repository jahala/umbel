import { unlink } from 'node:fs/promises';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// KillOpts
// ---------------------------------------------------------------------------

export interface KillOpts {
  name: string;
  removeState?: boolean;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// ---------------------------------------------------------------------------
// kill
// ---------------------------------------------------------------------------

export async function kill(opts: KillOpts): Promise<void> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};
  const removeState = opts.removeState !== false;

  await d.tmux.killSession(opts.name);

  if (removeState) {
    // Clean up provider-written files before removing the state dir. These
    // are files written into the project cwd at spawn-time (e.g. for Codex
    // and Gemini providers). Best-effort — ignore errors so a missing file
    // never blocks session cleanup.
    let meta: Awaited<ReturnType<typeof d.fs.readMeta>> | undefined;
    try {
      meta = await d.fs.readMeta(opts.name, env);
    } catch {
      // session may already be gone or never persisted — skip cleanup
    }
    if (meta !== undefined) {
      for (const filePath of meta.providerFiles) {
        await unlink(filePath).catch(() => undefined);
      }
    }

    await d.fs.rmSession(opts.name, env);
  }
}
