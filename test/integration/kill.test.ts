import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { hasSession, killSession, newSession } from '../../src/adapters/tmux.ts';
import { kill } from '../../src/operations/kill.ts';
import { spawn } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';
let projectsDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-kill-test-'));
  projectsDir = join(tmpDir, 'projects');
  return { UMBEL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

afterEach(async () => {
  // Best-effort cleanup for any leftover sessions
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
    projectsDir = '';
  }
});

// ---------------------------------------------------------------------------
// Shared spawn helper
// ---------------------------------------------------------------------------

function makeSpawnOpts(
  env: Record<string, string | undefined>,
  cwd: string,
  extra?: Partial<Parameters<typeof spawn>[0]>,
): Parameters<typeof spawn>[0] {
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const jsonlDir = join(projectsDir, encodedCwd);
  return {
    cwd,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    },
    deps: {
      jsonl: {
        ...jsonlAdapter,
        discoverSessionJsonl: (opts) =>
          jsonlAdapter.discoverSessionJsonl({ ...opts, projectsRoot: projectsDir }),
      },
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// kill — existing session
// ---------------------------------------------------------------------------

describe('kill — existing session', () => {
  test('removes tmux session and state dir', async () => {
    const env = await setup();
    const { session } = await spawn(makeSpawnOpts(env, '/tmp'));
    // Don't push to CREATED — kill under test handles cleanup
    const name = session.name;

    await kill({ name, env });

    expect(await hasSession(name)).toBe(false);

    const sessionDir = join(tmpDir, 'sessions', name);
    const { existsSync } = await import('node:fs');
    expect(existsSync(sessionDir)).toBe(false);
  });

  test('removeState=false leaves state dir intact', async () => {
    const env = await setup();
    const { session } = await spawn(makeSpawnOpts(env, '/tmp'));
    const name = session.name;

    await kill({ name, removeState: false, env });

    expect(await hasSession(name)).toBe(false);

    const metaPath = join(tmpDir, 'sessions', name, 'meta.json');
    const { existsSync } = await import('node:fs');
    expect(existsSync(metaPath)).toBe(true);
    // Clean up state manually since removeState=false
    await rm(join(tmpDir, 'sessions', name), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// kill — idempotent
// ---------------------------------------------------------------------------

describe('kill — idempotent', () => {
  test('does not throw when session does not exist in tmux', async () => {
    const env = await setup();
    const name = sessionName('notmux');

    // Create state dir without tmux session
    const { ensureSessionDir, writeMeta } = await import('../../src/adapters/fs-state.ts');
    const { SessionSchema } = await import('../../src/core/types.ts');
    await ensureSessionDir(name, env);
    const session = SessionSchema.parse({
      name,
      cwd: '/tmp',
      anonymous: true,
      createdAt: Date.now(),
      jsonlPath: null,
    });
    await writeMeta(name, session, env);

    // Should not throw — killSession is idempotent
    await expect(kill({ name, env })).resolves.toBeUndefined();
  });

  test('does not throw when neither tmux session nor state exists', async () => {
    const env = await setup();
    // A completely non-existent session name
    await expect(kill({ name: sessionName('ghost'), env })).resolves.toBeUndefined();
  });

  test('kill after manual tmux kill does not throw', async () => {
    const env = await setup();
    const { session } = await spawn(makeSpawnOpts(env, '/tmp'));
    const name = session.name;

    // Kill tmux externally first
    await killSession(name);
    // Now kill via operation — should still succeed
    await expect(kill({ name, env })).resolves.toBeUndefined();
  });

  test('double kill does not throw', async () => {
    const env = await setup();
    const { session } = await spawn(makeSpawnOpts(env, '/tmp'));
    const name = session.name;

    await kill({ name, env });
    await expect(kill({ name, env })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// kill — plain tmux session (no umbel state)
// ---------------------------------------------------------------------------

describe('kill — plain tmux session', () => {
  test('kills tmux session even if no state dir exists', async () => {
    const env = await setup();
    const name = sessionName('rawt');
    CREATED.push(name);
    await newSession({ name, cwd: '/tmp', cmd: ['bash'] });

    await kill({ name, env });
    expect(await hasSession(name)).toBe(false);
  });
});
