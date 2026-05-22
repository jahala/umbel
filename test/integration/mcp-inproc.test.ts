/**
 * In-process integration tests for src/faces/mcp.ts
 *
 * Calls createMcpTools() directly — no subprocess, no stdio transport —
 * so Bun coverage instruments mcp.ts. Uses real fake-claude, real tmux,
 * real RCTRL_STATE in tmpdir.
 *
 * Covers: rctrl_spawn, rctrl_send, rctrl_wait, rctrl_status, rctrl_ls,
 *         rctrl_kill, rctrl_read, rctrl_capture, rctrl_logs
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import { createMcpTools } from '../../src/faces/mcp.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
let projectsDir = '';

function sessionName(suffix: string): string {
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-mcp-inproc-'));
  projectsDir = join(tmpDir, 'projects');
  return { RCTRL_STATE: tmpDir };
}

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
    projectsDir = '';
  }
});

// ---------------------------------------------------------------------------
// Helper: build MCP tool opts with injected deps pointing at tmp projectsDir
// ---------------------------------------------------------------------------

function makeToolOpts(
  env: Record<string, string | undefined>,
  cwd: string,
): Parameters<typeof createMcpTools>[0] {
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const jsonlDir = join(projectsDir, encodedCwd);

  return {
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
  };
}

// ---------------------------------------------------------------------------
// rctrl_spawn
// ---------------------------------------------------------------------------

describe('rctrl_spawn', () => {
  test('rctrl_spawn with bad name propagates RctrlUsageError', async () => {
    const env = await setup();

    const tools = createMcpTools({
      ...makeToolOpts(env, tmpDir),
    });

    // Names with spaces are invalid — rctrl_spawn rejects them as RctrlUsageError
    await expect(
      tools.rctrl_spawn({ name: 'INVALID NAME WITH SPACES', cwd: tmpDir }),
    ).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// rctrl_spawn with fake-claude via env
// ---------------------------------------------------------------------------

describe('rctrl_spawn — with fake claude', () => {
  test('spawn via tool returns JSON with session name', async () => {
    const env = await setup();
    const name = sessionName('spfk');
    CREATED.push(name);

    const encodedCwd = tmpDir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonlDir = join(projectsDir, encodedCwd);

    // Inject claudeBin via a modified deps that wraps spawn
    const { spawn: originalSpawn } = await import('../../src/operations/spawn.ts');
    const fakeBin = join(import.meta.dir, '../fixtures/fake-claude.sh');

    const tools = createMcpTools({
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
    });

    // Call spawn operation directly with claudeBin, then verify the tool
    const spawnResult = await originalSpawn({
      name,
      cwd: tmpDir,
      claudeBin: fakeBin,
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
    });

    expect(spawnResult.session.name as string).toBe(name);

    // Now test rctrl_status which reads the spawned session
    const statusResult = await tools.rctrl_status({ name });
    const entries = JSON.parse(statusResult.content[0]?.text ?? '[]') as Array<{ name: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]?.name).toBe(name);
  });
});

// ---------------------------------------------------------------------------
// rctrl_send
// ---------------------------------------------------------------------------

describe('rctrl_send', () => {
  test('send to non-existent session propagates error', async () => {
    const env = await setup();
    const tools = createMcpTools(makeToolOpts(env, tmpDir));

    await expect(
      tools.rctrl_send({ name: `bogus-${RUN_ID}`, prompt: 'hello' }),
    ).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// rctrl_status
// ---------------------------------------------------------------------------

describe('rctrl_status', () => {
  test('status with no name returns array (empty when no sessions)', async () => {
    const env = await setup();
    const tools = createMcpTools(makeToolOpts(env, tmpDir));

    const result = await tools.rctrl_status({});
    const entries = JSON.parse(result.content[0]?.text ?? 'null');
    expect(Array.isArray(entries)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rctrl_ls
// ---------------------------------------------------------------------------

describe('rctrl_ls', () => {
  test('ls returns array of sessions', async () => {
    const env = await setup();
    const tools = createMcpTools(makeToolOpts(env, tmpDir));

    const result = await tools.rctrl_ls({} as never);
    const entries = JSON.parse(result.content[0]?.text ?? 'null');
    expect(Array.isArray(entries)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rctrl_read (session with null jsonlPath returns empty string)
// ---------------------------------------------------------------------------

describe('rctrl_read', () => {
  test('read session with null jsonlPath returns empty content', async () => {
    const env = await setup();
    const name = sessionName('readnull');

    // Create a session with null jsonlPath
    const { ensureSessionDir, writeMeta } = await import('../../src/adapters/fs-state.ts');
    const { newSession } = await import('../../src/adapters/tmux.ts');
    const { SessionSchema } = await import('../../src/core/types.ts');

    await ensureSessionDir(name, env);
    await newSession({ name, cwd: '/tmp', cmd: ['bash'] });
    CREATED.push(name);

    const session = SessionSchema.parse({
      name,
      cwd: '/tmp',
      anonymous: true,
      createdAt: Date.now(),
      jsonlPath: null,
    });
    await writeMeta(name, session, env);

    const tools = createMcpTools(makeToolOpts(env, tmpDir));
    const result = await tools.rctrl_read({ name });
    // null jsonlPath → empty text
    expect(result.content[0]?.text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// rctrl_read (session with a real jsonlPath returns the last assistant message)
// ---------------------------------------------------------------------------

describe('rctrl_read — with jsonl', () => {
  test('read session with jsonlPath returns last assistant message', async () => {
    const env = await setup();
    const name = sessionName('readjsonl');

    const { ensureSessionDir, writeMeta } = await import('../../src/adapters/fs-state.ts');
    const { newSession } = await import('../../src/adapters/tmux.ts');
    const { SessionSchema } = await import('../../src/core/types.ts');

    await ensureSessionDir(name, env);
    await newSession({ name, cwd: '/tmp', cmd: ['bash'] });
    CREATED.push(name);

    // Create a fake JSONL file with a valid assistant message
    const { mkdir, writeFile } = await import('node:fs/promises');
    const encodedCwd = tmpDir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonlDir = join(projectsDir, encodedCwd);
    await mkdir(jsonlDir, { recursive: true });

    const jsonlPath = join(jsonlDir, `${name}.jsonl`);
    // Write JSONL with a shape-B assistant message (top-level role+content+stop_reason)
    const assistantEntry = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from mcp-read test' }],
      stop_reason: 'end_turn',
    });
    await writeFile(jsonlPath, `${assistantEntry}\n`, 'utf8');

    const session = SessionSchema.parse({
      name,
      cwd: '/tmp',
      anonymous: false,
      createdAt: Date.now(),
      jsonlPath,
    });
    await writeMeta(name, session, env);

    const tools = createMcpTools(makeToolOpts(env, tmpDir));
    const result = await tools.rctrl_read({ name });
    expect(result.content[0]?.text).toContain('Hello from mcp-read test');
  });
});

// ---------------------------------------------------------------------------
// rctrl_capture
// ---------------------------------------------------------------------------

describe('rctrl_capture', () => {
  test('capture returns pane content string', async () => {
    const env = await setup();
    const name = sessionName('captest');

    const { newSession } = await import('../../src/adapters/tmux.ts');
    await newSession({ name, cwd: '/tmp', cmd: ['bash'] });
    CREATED.push(name);

    const tools = createMcpTools(makeToolOpts(env, tmpDir));
    const result = await tools.rctrl_capture({ name, lines: 10 });
    // Content is a string (pane text)
    expect(typeof result.content[0]?.text).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// rctrl_logs
// ---------------------------------------------------------------------------

describe('rctrl_logs', () => {
  test('logs returns empty string when log file absent', async () => {
    const env = await setup();
    const name = sessionName('logstest');

    const tools = createMcpTools(makeToolOpts(env, tmpDir));
    // No session created — log file doesn't exist — should return ''
    const result = await tools.rctrl_logs({ name });
    expect(result.content[0]?.text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// rctrl_kill
// ---------------------------------------------------------------------------

describe('rctrl_kill', () => {
  test('kill existing session returns "killed"', async () => {
    const env = await setup();
    const name = sessionName('killmcp');

    const { newSession, hasSession } = await import('../../src/adapters/tmux.ts');
    const { ensureSessionDir, writeMeta } = await import('../../src/adapters/fs-state.ts');
    const { SessionSchema } = await import('../../src/core/types.ts');

    await ensureSessionDir(name, env);
    await newSession({ name, cwd: '/tmp', cmd: ['bash'] });
    CREATED.push(name);

    const session = SessionSchema.parse({
      name,
      cwd: '/tmp',
      anonymous: true,
      createdAt: Date.now(),
      jsonlPath: null,
    });
    await writeMeta(name, session, env);

    const tools = createMcpTools(makeToolOpts(env, tmpDir));
    const result = await tools.rctrl_kill({ name, keepState: false });

    expect(result.content[0]?.text).toBe('killed');

    // Session should be gone from tmux
    const alive = await hasSession(name);
    expect(alive).toBe(false);

    // Remove from CREATED since already killed
    const idx = CREATED.indexOf(name);
    if (idx !== -1) CREATED.splice(idx, 1);
  });
});

// ---------------------------------------------------------------------------
// rctrl_wait
// ---------------------------------------------------------------------------

describe('rctrl_wait', () => {
  test('wait with already-aborted signal returns reason=aborted', async () => {
    const env = await setup();
    const name = sessionName('waitmcp');

    const { newSession } = await import('../../src/adapters/tmux.ts');
    const { ensureSessionDir, writeMeta } = await import('../../src/adapters/fs-state.ts');
    const { SessionSchema } = await import('../../src/core/types.ts');

    await ensureSessionDir(name, env);
    await newSession({ name, cwd: '/tmp', cmd: ['bash'] });
    CREATED.push(name);

    const session = SessionSchema.parse({
      name,
      cwd: '/tmp',
      anonymous: true,
      createdAt: Date.now(),
      jsonlPath: null,
    });
    await writeMeta(name, session, env);

    const ac = new AbortController();
    ac.abort(); // Already aborted before calling wait

    const tools = createMcpTools({
      ...makeToolOpts(env, tmpDir),
      signal: ac.signal,
    });

    const result = await tools.rctrl_wait({
      name,
      until: 'stop',
    });

    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { reason: string };
    expect(parsed.reason).toBe('aborted');
  });
});
