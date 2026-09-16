import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionNotFoundError } from '../core/errors.ts';
import type { DeadEvent, ExitRecord, Session } from '../core/types.ts';
import { DeadEventSchema, ExitRecordSchema, SessionSchema } from '../core/types.ts';

// ---------------------------------------------------------------------------
// Path helpers — all accept env explicitly, no direct process.env reads
// ---------------------------------------------------------------------------

export function stateDir(env: Record<string, string | undefined> = {}): string {
  return env.UMBEL_STATE ?? join(homedir(), '.umbel');
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
// writeJson — atomic temp-then-rename
// ---------------------------------------------------------------------------

// A reader of a state file is a separate umbel invocation with no lock to take,
// so the file has to appear whole or not at all.
async function writeJson(dir: string, file: string, value: unknown): Promise<void> {
  const tmp = join(dir, `.${file}.tmp.${Date.now()}`);
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, join(dir, file));
}

// ---------------------------------------------------------------------------
// writeMeta
// ---------------------------------------------------------------------------

export async function writeMeta(
  name: string,
  session: Session,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  await writeJson(sessionDir(name, env), 'meta.json', SessionSchema.parse(session));
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
// writeDead / readDead — events/dead, how the worker went
// ---------------------------------------------------------------------------

// The record outlives the pane it was read from, so a post-mortem needs only
// the session directory. Written once per death; the events dir is created if
// the writer got there before it existed.

export async function writeDead(
  name: string,
  event: DeadEvent,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const dir = eventsDir(name, env);
  await mkdir(dir, { recursive: true });
  await writeJson(dir, 'dead', DeadEventSchema.parse(event));
}

// null when the worker has not been found dead, or when the record on disk is
// unreadable — a post-mortem that cannot be read is the same as none.
export async function readDead(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<DeadEvent | null> {
  const file = Bun.file(join(eventsDir(name, env), 'dead'));
  if (!(await file.exists())) return null;
  try {
    return DeadEventSchema.parse(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// readExit / clearExit — events/exit, written by the launch wrapper
// ---------------------------------------------------------------------------

// null while the worker runs, and when the record is unreadable.
export async function readExit(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<ExitRecord | null> {
  const file = Bun.file(join(eventsDir(name, env), 'exit'));
  if (!(await file.exists())) return null;
  try {
    return ExitRecordSchema.parse(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

// A name spawned again keeps its tombstone, and a record left from the last
// worker would otherwise answer for the new one if it dies unrecorded.
export async function clearExit(
  name: string,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  await rm(join(eventsDir(name, env), 'exit'), { force: true });
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
