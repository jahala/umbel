import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionDeadError } from '../core/errors.ts';

// ---------------------------------------------------------------------------
// encodeCwd — claude resolves symlinks before encoding, so we must too.
// On macOS, /var/folders/... resolves to /private/var/folders/... and the
// project dir is named after the resolved path. Without realpath, we end up
// looking in the wrong dir entirely.
// ---------------------------------------------------------------------------

export function encodeCwd(cwd: string): string {
  if (cwd === '') return '';
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // Path doesn't exist (yet); fall back to literal — caller's problem.
    resolved = cwd;
  }
  return resolved.replace(/[^a-zA-Z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// discoverSessionJsonl
// ---------------------------------------------------------------------------

export async function discoverSessionJsonl(opts: {
  sessionName: string;
  cwd: string;
  sinceMs: number;
  projectsRoot?: string;
  timeoutMs?: number;
}): Promise<string> {
  const projectsRoot = opts.projectsRoot ?? join(homedir(), '.claude', 'projects');
  const projectDir = join(projectsRoot, encodeCwd(opts.cwd));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;

  // Filesystem mtime precision is 1s on ext4 with old kernels and on FAT-family
  // mounts. sinceMs is captured at ms precision; comparing them naively misses
  // files created in the same second. Subtract 1s of tolerance.
  const FS_PRECISION_TOLERANCE_MS = 1000;
  const sinceThreshold = opts.sinceMs - FS_PRECISION_TOLERANCE_MS;

  async function findCandidates(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(projectDir);
    } catch {
      return [];
    }
    const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
    const candidates: Array<{ path: string; createdAt: number }> = [];
    for (const f of jsonlFiles) {
      const fullPath = join(projectDir, f);
      try {
        const s = await stat(fullPath);
        // birthtimeMs is unreliable on some Linux filesystems (returns 0).
        // Fall back to mtimeMs when birthtime is unavailable.
        const createdAt = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
        if (createdAt >= sinceThreshold) {
          candidates.push({ path: fullPath, createdAt });
        }
      } catch {
        // skip unreadable
      }
    }
    candidates.sort((a, b) => b.createdAt - a.createdAt);
    return candidates.map((c) => c.path);
  }

  let delay = 100;
  while (true) {
    const found = await findCandidates();
    const first = found[0];
    if (first !== undefined) {
      return first;
    }
    if (Date.now() + delay > deadline) {
      throw new SessionDeadError(opts.sessionName, 'no JSONL file appeared within timeout');
    }
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 500);
  }
}
