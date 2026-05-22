import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import { SessionNotFoundError } from '../../src/core/errors.ts';
import { kill } from '../../src/operations/kill.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { status } from '../../src/operations/status.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';
let projectsDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-status-test-'));
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
// status — listing
// ---------------------------------------------------------------------------

describe('status — listing', () => {
  test('returns entries for all spawned sessions', async () => {
    const env = await setup();

    const { session: s1 } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('s1') }));
    const { session: s2 } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('s2') }));
    CREATED.push(s1.name, s2.name);

    const entries = await status({ env });
    const names = entries.map((e) => e.name);
    expect(names).toContain(s1.name);
    expect(names).toContain(s2.name);
  });

  test('both sessions are alive after spawn', async () => {
    const env = await setup();

    const { session: s1 } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('a1') }));
    const { session: s2 } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('a2') }));
    CREATED.push(s1.name, s2.name);

    const entries = await status({ env });
    const entry1 = entries.find((e) => e.name === s1.name);
    const entry2 = entries.find((e) => e.name === s2.name);
    expect(entry1?.alive).toBe(true);
    expect(entry2?.alive).toBe(true);
  });

  test('entries are sorted by createdAt ascending', async () => {
    const env = await setup();

    const { session: s1 } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('ord1') }));
    await Bun.sleep(50); // ensure different createdAt
    const { session: s2 } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('ord2') }));
    CREATED.push(s1.name, s2.name);

    const entries = await status({ env });
    const names = entries.map((e) => e.name);
    const idx1 = names.indexOf(s1.name);
    const idx2 = names.indexOf(s2.name);
    expect(idx1).toBeLessThan(idx2);
  });

  test('returns empty array when no sessions exist', async () => {
    const env = await setup();
    const entries = await status({ env });
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// status — single session
// ---------------------------------------------------------------------------

describe('status — single session', () => {
  test('returns entry for named session', async () => {
    const env = await setup();
    const name = sessionName('single');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    const entries = await status({ name, env });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name as string).toBe(name);
    expect(entries[0]?.alive).toBe(true);
  });

  test('throws SessionNotFoundError for missing session', async () => {
    const env = await setup();
    await expect(status({ name: sessionName('nosuchsession'), env })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// status — alive tracking
// ---------------------------------------------------------------------------

describe('status — alive after kill', () => {
  test('alive=false after kill', async () => {
    const env = await setup();
    const name = sessionName('tokill');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    // Kill just the tmux part, leave state
    await kill({ name, removeState: false, env });

    const entries = await status({ name, env });
    expect(entries[0]?.alive).toBe(false);

    // Cleanup state
    await kill({ name, env });
  });
});

// ---------------------------------------------------------------------------
// status — lastActivityAt
// ---------------------------------------------------------------------------

describe('status — lastActivityAt', () => {
  test('lastActivityAt is set after fake-claude fires stop hook', async () => {
    const env = await setup();
    const name = sessionName('activity');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    // Send a prompt so fake-claude processes a turn and fires the stop hook
    const { sendText } = await import('../../src/adapters/tmux.ts');
    await sendText(session.name, 'hello');

    // Wait for the stop hook to fire (which writes to events/log)
    const logPath = join(tmpDir, 'sessions', name, 'events', 'log');
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        const { stat } = await import('node:fs/promises');
        await stat(logPath);
        break;
      } catch {
        await Bun.sleep(100);
      }
    }

    const entries = await status({ name, env });
    expect(entries[0]?.lastActivityAt).toBeNumber();
    expect(entries[0]?.lastActivityAt ?? 0).toBeGreaterThan(0);
  });
});
