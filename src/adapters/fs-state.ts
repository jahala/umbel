import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionNotFoundError } from '../core/errors.ts';
import { SessionSchema } from '../core/types.ts';
import type { Session } from '../core/types.ts';

// ---------------------------------------------------------------------------
// Path helpers — all accept env explicitly, no direct process.env reads
// ---------------------------------------------------------------------------

export function stateDir(env: Record<string, string | undefined> = {}): string {
  return env.RCTRL_STATE ?? join(homedir(), '.rctrl');
}

export function sessionDir(name: string, env: Record<string, string | undefined> = {}): string {
  return join(stateDir(env), 'sessions', name);
}

export function eventsDir(name: string, env: Record<string, string | undefined> = {}): string {
  return join(sessionDir(name, env), 'events');
}

// ---------------------------------------------------------------------------
// ensureSessionDir
// ---------------------------------------------------------------------------

export async function ensureSessionDir(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  await mkdir(eventsDir(name, env), { recursive: true });
}

// ---------------------------------------------------------------------------
// writeMeta — atomic temp-then-rename
// ---------------------------------------------------------------------------

export async function writeMeta(
  name: string,
  session: Session,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const validated = SessionSchema.parse(session);
  const dir = sessionDir(name, env);
  const target = join(dir, 'meta.json');
  const tmp = join(dir, `.meta.json.tmp.${Date.now()}`);
  await writeFile(tmp, JSON.stringify(validated, null, 2), 'utf8');
  await rename(tmp, target);
}

// ---------------------------------------------------------------------------
// readMeta
// ---------------------------------------------------------------------------

export async function readMeta(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<Session> {
  const path = join(sessionDir(name, env), 'meta.json');
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new SessionNotFoundError(name);
  }
  const raw = await file.text();
  const parsed = SessionSchema.parse(JSON.parse(raw));
  return parsed;
}

// ---------------------------------------------------------------------------
// rmSession — idempotent
// ---------------------------------------------------------------------------

export async function rmSession(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  await rm(sessionDir(name, env), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// listSessionNames — sorted alphabetically
// ---------------------------------------------------------------------------

export async function listSessionNames(
  env: Record<string, string | undefined> = {},
): Promise<string[]> {
  const sessionsRoot = join(stateDir(env), 'sessions');
  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    const metaPath = join(sessionsRoot, entry, 'meta.json');
    const exists = await Bun.file(metaPath).exists();
    if (exists) {
      names.push(entry);
    }
  }
  return names.sort();
}
