import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSessionDir,
  eventsDir,
  listSessionNames,
  readMeta,
  rmSession,
  sessionDir,
  stateDir,
  writeMeta,
} from '../../src/adapters/fs-state.ts';
import { SessionNotFoundError } from '../../src/core/errors.ts';
import type { Session } from '../../src/core/types.ts';

// Each test gets an isolated temp state dir
let tmpDir: string;

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-fs-state-test-'));
  return { UMBEL_STATE: tmpDir };
}

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

function makeSession(name: string): Session {
  return {
    name: name as Session['name'],
    cwd: '/tmp/test',
    model: 'sonnet',
    provider: 'claude',
    providerFiles: [],
    anonymous: false,
    createdAt: Date.now(),
    jsonlPath: null,
    baseUrl: null,
  };
}

describe('stateDir', () => {
  test('returns UMBEL_STATE env var when set', () => {
    expect(stateDir({ UMBEL_STATE: '/custom/path' })).toBe('/custom/path');
  });

  test('falls back to ~/.umbel when UMBEL_STATE unset', () => {
    const result = stateDir({});
    expect(result).toMatch(/\.umbel$/);
  });
});

describe('sessionDir', () => {
  test('returns correct path', async () => {
    const env = await setup();
    const result = sessionDir('mysession', env);
    expect(result).toBe(join(tmpDir, 'sessions', 'mysession'));
  });
});

describe('eventsDir', () => {
  test('returns correct path under session dir', async () => {
    const env = await setup();
    const result = eventsDir('mysession', env);
    expect(result).toBe(join(tmpDir, 'sessions', 'mysession', 'events'));
  });
});

describe('ensureSessionDir', () => {
  test('creates session dir and events subdir', async () => {
    const env = await setup();
    await ensureSessionDir('newsession', env);
    const { statSync } = await import('node:fs');
    expect(statSync(join(tmpDir, 'sessions', 'newsession')).isDirectory()).toBe(true);
  });

  test('is idempotent — no error on second call', async () => {
    const env = await setup();
    await ensureSessionDir('idempotent', env);
    await expect(ensureSessionDir('idempotent', env)).resolves.toBeUndefined();
  });
});

describe('writeMeta + readMeta', () => {
  test('round-trip: written data matches read data', async () => {
    const env = await setup();
    const name = 'roundtrip';
    const session = makeSession(name);
    await ensureSessionDir(name, env);
    await writeMeta(name, session, env);
    const read = await readMeta(name, env);
    expect(read.name).toBe(session.name);
    expect(read.cwd).toBe(session.cwd);
    expect(read.anonymous).toBe(session.anonymous);
    expect(read.createdAt).toBe(session.createdAt);
    expect(read.jsonlPath).toBeNull();
  });

  test('writeMeta is atomic — temp file then rename', async () => {
    const env = await setup();
    const name = 'atomic';
    const session = makeSession(name);
    await ensureSessionDir(name, env);

    // Write initial version
    await writeMeta(name, session, env);
    const first = await readMeta(name, env);

    // Overwrite with new data
    const updated: Session = { ...session, cwd: '/updated/path' };
    await writeMeta(name, updated, env);
    const second = await readMeta(name, env);

    expect(first.cwd).toBe('/tmp/test');
    expect(second.cwd).toBe('/updated/path');
  });

  test('readMeta throws SessionNotFoundError if missing', async () => {
    const env = await setup();
    await expect(readMeta('doesnotexist', env)).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('rmSession', () => {
  test('removes the session directory', async () => {
    const env = await setup();
    const name = 'todelete';
    await ensureSessionDir(name, env);
    await writeMeta(name, makeSession(name), env);
    await rmSession(name, env);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(tmpDir, 'sessions', name))).toBe(false);
  });

  test('is idempotent — no error if already gone', async () => {
    const env = await setup();
    await expect(rmSession('nevercreated', env)).resolves.toBeUndefined();
  });
});

describe('listSessionNames', () => {
  test('returns empty array when no sessions', async () => {
    const env = await setup();
    const names = await listSessionNames(env);
    expect(names).toEqual([]);
  });

  test('returns all session names', async () => {
    const env = await setup();
    const names = ['alpha', 'beta', 'gamma'];
    for (const n of names) {
      await ensureSessionDir(n, env);
      await writeMeta(n, makeSession(n), env);
    }
    const result = await listSessionNames(env);
    expect(result.sort()).toEqual(names.sort());
  });

  test('is deterministic (sorted)', async () => {
    const env = await setup();
    const names = ['charlie', 'alice', 'bob'];
    for (const n of names) {
      await ensureSessionDir(n, env);
      await writeMeta(n, makeSession(n), env);
    }
    const result1 = await listSessionNames(env);
    const result2 = await listSessionNames(env);
    expect(result1).toEqual(result2);
  });
});
