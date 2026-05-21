import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession, listSessions } from '../../src/adapters/tmux.ts';
import { RctrlUsageError } from '../../src/core/errors.ts';
import { spawn } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';
let projectsDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-spawn-test-'));
  projectsDir = join(tmpDir, 'projects');
  return { RCTRL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  // Must pass SessionNameSchema: lowercase, starts with letter/digit
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
// Helper: build spawn opts with injected deps pointing at tmp projectsDir
// ---------------------------------------------------------------------------

function makeOpts(
  env: Record<string, string | undefined>,
  cwd: string,
  extra?: Partial<Parameters<typeof spawn>[0]>,
): Parameters<typeof spawn>[0] {
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const jsonlDir = join(projectsDir, encodedCwd);

  const hookPath = join(tmpDir, 'hooks', 'stop.sh');

  return {
    cwd,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: hookPath,
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
// Anonymous spawn
// ---------------------------------------------------------------------------

describe('spawn — anonymous', () => {
  test('auto-generates name matching anon-XXXXXX pattern', async () => {
    const env = await setup();
    const { session } = await spawn(makeOpts(env, '/tmp'));
    CREATED.push(session.name);
    expect(session.name).toMatch(/^anon-[a-z0-9]{6}$/);
    expect(session.anonymous).toBe(true);
  });

  test('tmux session is created', async () => {
    const env = await setup();
    const { session } = await spawn(makeOpts(env, '/tmp'));
    CREATED.push(session.name);
    const sessions = await listSessions();
    expect(sessions).toContain(session.name);
  });

  test('meta.json is written to state dir', async () => {
    const env = await setup();
    const { session } = await spawn(makeOpts(env, '/tmp'));
    CREATED.push(session.name);
    const metaPath = join(tmpDir, 'sessions', session.name, 'meta.json');
    const s = await stat(metaPath);
    expect(s.isFile()).toBe(true);
  });

  test('jsonlPath is discovered', async () => {
    const env = await setup();
    const { jsonlPath, session } = await spawn(makeOpts(env, '/tmp'));
    CREATED.push(session.name);
    expect(typeof jsonlPath).toBe('string');
    expect(jsonlPath.endsWith('.jsonl')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Named spawn
// ---------------------------------------------------------------------------

describe('spawn — named', () => {
  test('uses exact name, anonymous=false', async () => {
    const env = await setup();
    const name = sessionName('named');
    const { session } = await spawn(makeOpts(env, '/tmp', { name }));
    CREATED.push(session.name);
    // Cast to string for comparison — branded type
    expect(session.name as string).toBe(name);
    expect(session.anonymous).toBe(false);
  });

  test('explicit anonymous=true overrides name-based default', async () => {
    const env = await setup();
    const name = sessionName('anon-override');
    const { session } = await spawn(makeOpts(env, '/tmp', { name, anonymous: true }));
    CREATED.push(session.name);
    expect(session.anonymous).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid name
// ---------------------------------------------------------------------------

describe('spawn — invalid name', () => {
  test('throws RctrlUsageError for invalid session name', async () => {
    const env = await setup();
    await expect(spawn(makeOpts(env, '/tmp', { name: 'INVALID_NAME!' }))).rejects.toBeInstanceOf(
      RctrlUsageError,
    );
  });

  test('throws RctrlUsageError for name starting with hyphen', async () => {
    const env = await setup();
    await expect(spawn(makeOpts(env, '/tmp', { name: '-bad' }))).rejects.toBeInstanceOf(
      RctrlUsageError,
    );
  });
});

// ---------------------------------------------------------------------------
// Stop hook fires
// ---------------------------------------------------------------------------

describe('spawn — stop hook', () => {
  test('stop file appears after sending a prompt to fake-claude', async () => {
    const env = await setup();
    const { session } = await spawn(makeOpts(env, '/tmp'));
    CREATED.push(session.name);

    // Send a prompt so fake-claude processes a turn and fires the hook
    const { sendText } = await import('../../src/adapters/tmux.ts');
    await sendText(session.name, 'hello');

    const stopPath = join(tmpDir, 'sessions', session.name, 'events', 'stop');
    const deadline = Date.now() + 6000;
    let found = false;
    while (Date.now() < deadline) {
      try {
        await stat(stopPath);
        found = true;
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(found).toBe(true);
  });
});
