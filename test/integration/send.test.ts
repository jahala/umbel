import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import { SessionDeadError, SessionNotFoundError } from '../../src/core/errors.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';
let projectsDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-send-test-'));
  projectsDir = join(tmpDir, 'projects');
  return { RCTRL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
    projectsDir = '';
  }
});

// ---------------------------------------------------------------------------
// Shared helpers
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
// send after spawn
// ---------------------------------------------------------------------------

describe('send — basic', () => {
  test('returns sinceMtime (a number)', async () => {
    const env = await setup();
    const { session } = await spawn(makeSpawnOpts(env, '/tmp'));
    CREATED.push(session.name);

    const result = await send({ name: session.name, prompt: 'hello', env });
    expect(typeof result.sinceMtime).toBe('number');
  });

  test('sinceMtime is 0 when stop has never fired before first send', async () => {
    const env = await setup();
    // Spawn a new session — events/stop doesn't exist yet
    const { session } = await spawn(makeSpawnOpts(env, '/tmp'));
    CREATED.push(session.name);

    const result = await send({ name: session.name, prompt: 'hello', env });
    // sinceMtime should be 0 since events/stop didn't exist before send
    expect(result.sinceMtime).toBe(0);
  });

  test('multi-line prompt does not throw', async () => {
    const env = await setup();
    const { session } = await spawn(makeSpawnOpts(env, '/tmp'));
    CREATED.push(session.name);

    await expect(
      send({ name: session.name, prompt: 'line one\nline two', env }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// send — error cases
// ---------------------------------------------------------------------------

describe('send — errors', () => {
  test('throws SessionNotFoundError for non-existent session', async () => {
    const env = await setup();
    await expect(
      send({ name: sessionName('notfound'), prompt: 'hello', env }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  test('throws SessionDeadError when tmux session is gone', async () => {
    const env = await setup();
    const { session } = await spawn(makeSpawnOpts(env, '/tmp'));
    CREATED.push(session.name);

    // Kill the tmux session externally, leaving meta.json intact
    await killSession(session.name);

    await expect(send({ name: session.name, prompt: 'hello', env })).rejects.toBeInstanceOf(
      SessionDeadError,
    );
  });
});
