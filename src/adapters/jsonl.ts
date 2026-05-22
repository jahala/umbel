import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonlMalformedError, SessionDeadError } from '../core/errors.ts';

// ---------------------------------------------------------------------------
// encodeCwd — replace non-alphanumeric chars with '-'
// ---------------------------------------------------------------------------

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// Internal: parse a single JSONL line defensively
// ---------------------------------------------------------------------------

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: extract text content from a parsed JSONL entry
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

function extractText(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const obj = entry as JsonObj;

  // Shape A: { message: { role: 'assistant', content: [...] } }
  const msgField = obj.message;
  if (msgField !== null && typeof msgField === 'object') {
    const msg = msgField as JsonObj;
    if (msg.role === 'assistant') {
      return extractTextFromContent(msg.content);
    }
  }

  // Shape B: { role: 'assistant', content: '...' or [...] }
  if (obj.role === 'assistant') {
    return extractTextFromContent(obj.content);
  }

  return null;
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item !== null && typeof item === 'object') {
        const block = item as JsonObj;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: check if entry has a stop_reason indicating completion
// ---------------------------------------------------------------------------

function hasStopReason(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const obj = entry as JsonObj;

  // Shape A: message.stop_reason
  const msg = obj.message;
  if (msg !== null && typeof msg === 'object') {
    const m = msg as JsonObj;
    if (m.stop_reason !== null && m.stop_reason !== undefined) {
      return true;
    }
  }

  // Shape B: top-level stop_reason
  if (obj.stop_reason !== null && obj.stop_reason !== undefined) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Internal: check if entry is an assistant entry
// ---------------------------------------------------------------------------

function isAssistantEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const obj = entry as JsonObj;

  // Shape A: message.role === 'assistant'
  const msg = obj.message;
  if (msg !== null && typeof msg === 'object') {
    const m = msg as JsonObj;
    if (m.role === 'assistant') return true;
  }

  // Shape B: role === 'assistant'
  if (obj.role === 'assistant') return true;

  // Shape C: type === 'assistant'
  if (obj.type === 'assistant') return true;

  return false;
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

// ---------------------------------------------------------------------------
// lastAssistantMessage
// ---------------------------------------------------------------------------

export async function lastAssistantMessage(opts: {
  jsonlPath: string;
  retryUntilComplete?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
}): Promise<string> {
  const retryUntilComplete = opts.retryUntilComplete ?? true;
  const maxRetries = opts.maxRetries ?? 10;
  const retryDelayMs = opts.retryDelayMs ?? 50;

  let attempts = 0;
  while (true) {
    const result = await readLastAssistantGroup(opts.jsonlPath);
    if (result.complete || !retryUntilComplete || attempts >= maxRetries) {
      return result.text;
    }
    attempts++;
    await Bun.sleep(retryDelayMs);
  }
}

interface GroupResult {
  text: string;
  complete: boolean;
}

async function readLastAssistantGroup(jsonlPath: string): Promise<GroupResult> {
  const raw = await Bun.file(jsonlPath).text();
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { text: '', complete: true };
  }

  // Parse all lines, throwing on malformed
  const entries: unknown[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed === null) {
      throw new JsonlMalformedError(jsonlPath);
    }
    entries.push(parsed);
  }

  // Walk backward collecting consecutive assistant entries (the last turn)
  const lastGroup: unknown[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isAssistantEntry(entry)) {
      lastGroup.unshift(entry);
    } else {
      break;
    }
  }

  if (lastGroup.length === 0) {
    return { text: '', complete: true };
  }

  // Check if the last entry in the group has a stop_reason
  const lastEntry = lastGroup[lastGroup.length - 1];
  const complete = hasStopReason(lastEntry);

  // Concatenate text from all entries in their original order
  const textParts: string[] = [];
  for (const entry of lastGroup) {
    const t = extractText(entry);
    if (t !== null) {
      textParts.push(t);
    }
  }

  return { text: textParts.join(''), complete };
}
