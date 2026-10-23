import { type Dirent, realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionDeadError } from '../core/errors.ts';
import type { TranscriptSearch } from '../core/providers/types.ts';

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

// Filesystem mtime precision is 1s on ext4 with old kernels and on FAT-family
// mounts. sinceMs is captured at ms precision; comparing them naively misses
// files created in the same second. Subtract 1s of tolerance.
const FS_PRECISION_TOLERANCE_MS = 1000;

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

// ---------------------------------------------------------------------------
// discoverTranscript — a provider-described search below a directory tree
// ---------------------------------------------------------------------------
//
// Used before any hook names a transcript (codex writes its rollout at the
// first turn start, under $CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/). The tree is
// shared by every worker on this state root, so a candidate counts only when
// the provider's `belongs` says its first line is this worker's.

// A session_meta line carries the instruction body; only its head is needed to
// read the cwd, and a full rollout can be hundreds of megabytes.
const FIRST_LINE_MAX_BYTES = 256 * 1024;

function isTranscriptName(name: string, search: TranscriptSearch): boolean {
  if (search.prefix !== undefined && !name.startsWith(search.prefix)) return false;
  if (search.suffix !== undefined && !name.endsWith(search.suffix)) return false;
  return true;
}

async function collectFiles(
  dir: string,
  levelsLeft: number,
  search: TranscriptSearch,
  out: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A directory that cannot be read holds no transcript this worker can use;
    // the search goes on through the rest of the tree.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (levelsLeft > 0) await collectFiles(full, levelsLeft - 1, search, out);
    } else if (entry.isFile() && isTranscriptName(entry.name, search)) {
      out.push(full);
    }
  }
}

async function firstLineOf(path: string): Promise<string> {
  try {
    const text = await Bun.file(path).slice(0, FIRST_LINE_MAX_BYTES).text();
    return text.split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

// The newest bytes of a transcript. status asks every live worker which model
// it runs and whether a request is in flight, and a codex rollout can run to
// hundreds of megabytes; both answers are written at the end of a turn, so the
// tail is enough. A partial first line parses to nothing and is skipped by the
// providers' line readers (umbel#69).
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export async function readTranscriptTail(
  path: string,
  maxBytes = TRANSCRIPT_TAIL_BYTES,
): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  if (size <= maxBytes) return file.text();
  return file.slice(size - maxBytes, size).text();
}

export async function discoverTranscript(opts: {
  sessionName: string;
  cwd: string;
  sinceMs: number;
  search: TranscriptSearch;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  const sinceThreshold = opts.sinceMs - FS_PRECISION_TOLERANCE_MS;
  let realCwd = opts.cwd;
  try {
    realCwd = realpathSync(opts.cwd);
  } catch {
    // Path does not exist; the raw cwd is the only thing to compare against.
  }

  async function findCandidates(): Promise<string[]> {
    const files: string[] = [];
    for (const dir of opts.search.dirs) {
      await collectFiles(dir, opts.search.depth ?? 0, opts.search, files);
    }

    const candidates: Array<{ path: string; createdAt: number }> = [];
    for (const path of files) {
      try {
        const s = await stat(path);
        const createdAt = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
        if (createdAt >= sinceThreshold) candidates.push({ path, createdAt });
      } catch {
        // skip unreadable
      }
    }
    candidates.sort((a, b) => b.createdAt - a.createdAt);

    const belongs = opts.search.belongs;
    if (belongs === undefined) return candidates.map((c) => c.path);
    const matching: string[] = [];
    for (const candidate of candidates) {
      const firstLine = await firstLineOf(candidate.path);
      if (firstLine !== '' && belongs(firstLine, realCwd)) matching.push(candidate.path);
    }
    return matching;
  }

  let delay = 100;
  while (true) {
    const found = await findCandidates();
    const first = found[0];
    if (first !== undefined) return first;
    if (Date.now() + delay > deadline) {
      throw new SessionDeadError(opts.sessionName, 'no transcript matched within timeout');
    }
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 500);
  }
}
