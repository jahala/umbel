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
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-status-test-'));
  projectsDir = join(tmpDir, 'projects');
  return { UMBEL_STATE: tmpDir };
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

// ---------------------------------------------------------------------------
// status — effective routing (baseUrl)
// ---------------------------------------------------------------------------

describe('status — effective routing (baseUrl)', () => {
  test('surfaces the effective ANTHROPIC_BASE_URL as baseUrl', async () => {
    const env = await setup();
    const name = sessionName('routed');
    const url = 'https://api.deepseek.com/anthropic';
    const { session } = await spawn(
      makeSpawnOpts(env, '/tmp', { name, workerEnv: { ANTHROPIC_BASE_URL: url } }),
    );
    CREATED.push(session.name);

    const entries = await status({ name, env });
    expect(entries[0]?.baseUrl).toBe(url);
  });

  test('baseUrl is null for a worker with no custom endpoint', async () => {
    const env = await setup();
    const name = sessionName('unrouted');
    const prev = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
      CREATED.push(session.name);

      const entries = await status({ name, env });
      expect(entries[0]?.baseUrl).toBeNull();
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_BASE_URL = prev;
    }
  });

  test('surfaces routing without leaking the auth token', async () => {
    const env = await setup();
    const name = sessionName('noleak');
    const url = 'https://api.deepseek.com/anthropic';
    const secret = 'sk-must-not-appear-in-status';
    const { session } = await spawn(
      makeSpawnOpts(env, '/tmp', {
        name,
        workerEnv: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: secret },
      }),
    );
    CREATED.push(session.name);

    const entries = await status({ name, env });
    expect(entries[0]?.baseUrl).toBe(url);
    expect(JSON.stringify(entries[0])).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// status — needsInput (worker blocked on a prompt)
// ---------------------------------------------------------------------------

describe('status — needsInput', () => {
  // The Notification hook appends a JSONL line; status classifies the latest one.
  async function writeNotif(name: string, obj: object): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const notifPath = join(tmpDir, 'sessions', name, 'events', 'notification');
    await writeFile(notifPath, `${JSON.stringify(obj)}\n`);
  }

  test('needsInput + needsInputReason=permission for a pending permission prompt', async () => {
    const env = await setup();
    const name = sessionName('needperm');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);
    await writeNotif(name, {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
    });

    const entries = await status({ name, env });
    expect(entries[0]?.needsInput).toBe(true);
    expect(entries[0]?.needsInputReason).toBe('permission');
  });

  test('needsInputReason=idle for a done-and-idle worker (NOT mislabeled blocked)', async () => {
    const env = await setup();
    const name = sessionName('needidle');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);
    await writeNotif(name, {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });

    const entries = await status({ name, env });
    expect(entries[0]?.needsInput).toBe(true);
    expect(entries[0]?.needsInputReason).toBe('idle');
  });

  test('pendingTool surfaced when the notification carries a tool', async () => {
    const env = await setup();
    const name = sessionName('needtool');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);
    await writeNotif(name, { hook_event_name: 'PermissionRequest', tool_name: 'shell' });

    const entries = await status({ name, env });
    expect(entries[0]?.needsInputReason).toBe('permission');
    expect(entries[0]?.pendingTool).toBe('shell');
  });

  test('an informational notification (auth_success) is NOT needsInput', async () => {
    const env = await setup();
    const name = sessionName('authn');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);
    await writeNotif(name, { notification_type: 'auth_success', message: 'login ok' });

    const entries = await status({ name, env });
    expect(entries[0]?.needsInput).toBe(false);
  });

  test('needsInput is false for a session with no pending notification', async () => {
    const env = await setup();
    const name = sessionName('noinput');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    const entries = await status({ name, env });
    expect(entries[0]?.needsInput).toBe(false);
  });
});
