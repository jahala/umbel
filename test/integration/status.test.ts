import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureGlobalHooks } from '../../src/adapters/hooks.ts';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import { SessionNotFoundError } from '../../src/core/errors.ts';
import { kill } from '../../src/operations/kill.ts';
import { send } from '../../src/operations/send.ts';
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

// Transcript discovery inside the test's own projects root, never the real
// ~/.claude. Shared by the tests that need status to find a transcript.
function transcriptDeps(): NonNullable<Parameters<typeof status>[0]['deps']> {
  return {
    jsonl: {
      ...jsonlAdapter,
      discoverSessionJsonl: (opts) =>
        jsonlAdapter.discoverSessionJsonl({ ...opts, projectsRoot: projectsDir }),
    },
  };
}

// Where claude's discovery looks for a worker in /tmp: <projectsRoot>/<encoded
// resolved cwd>. The fake writes its JSONL there so a listing finds it.
function claudeProjectDir(): string {
  return join(projectsDir, jsonlAdapter.encodeCwd('/tmp'));
}

function claudeSpawnOpts(
  env: Record<string, string | undefined>,
  name: string,
  extraEnv: Record<string, string> = {},
): Parameters<typeof spawn>[0] {
  return makeSpawnOpts(env, '/tmp', {
    name,
    env: {
      ...env,
      FAKE_CLAUDE_JSONL_DIR: claudeProjectDir(),
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
      ...extraEnv,
    },
  });
}

async function entryOf(name: string, env: Record<string, string | undefined>) {
  const [entry] = await status({ name, env, deps: transcriptDeps() });
  return entry;
}

// Wait for the event, never a fixed time: poll until the worker reports the
// wanted state, bounded by the test's own deadline.
async function waitForState(
  name: string,
  env: Record<string, string | undefined>,
  wanted: string,
  withinMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + withinMs;
  let seen = (await entryOf(name, env))?.state;
  while (seen !== wanted && Date.now() < deadline) {
    await Bun.sleep(100);
    seen = (await entryOf(name, env))?.state;
  }
  return seen;
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

  // A machine that has spawned workers all day holds hundreds of tombstones,
  // and a caller asking "what is running" wants the live ones (umbel#70).
  test('leaves a dead session out unless all is set', async () => {
    const env = await setup();

    const { session: live } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('lv') }));
    const { session: gone } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('gd') }));
    CREATED.push(live.name, gone.name);
    await kill({ name: gone.name, env });

    const listed = (await status({ env })).map((e) => e.name);
    expect(listed).toContain(live.name);
    expect(listed).not.toContain(gone.name);

    const every = await status({ env, all: true });
    expect(every.map((e) => e.name)).toContain(gone.name);
    expect(every.find((e) => e.name === gone.name)?.alive).toBe(false);

    await kill({ name: gone.name, purge: true, env });
  });

  // The single-session read is how a caller asks about a worker it killed: the
  // tombstone still answers (umbel#65).
  test('a named session is answered even when it is dead', async () => {
    const env = await setup();
    const { session: gone } = await spawn(makeSpawnOpts(env, '/tmp', { name: sessionName('dgn') }));
    CREATED.push(gone.name);
    await kill({ name: gone.name, env });

    const [entry] = await status({ name: gone.name, env });
    expect(entry?.alive).toBe(false);

    await kill({ name: gone.name, purge: true, env });
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
    await kill({ name, env });

    const entries = await status({ name, env });
    expect(entries[0]?.alive).toBe(false);

    // Cleanup state
    await kill({ name, purge: true, env });
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

  // The events log advances only when a hook fires. A worker eleven minutes
  // into its first turn has no hook yet, so LAST read as `—` and nothing in the
  // listing told a working worker from a wedged one (umbel#71).
  test('a turn in progress reaches LAST through the transcript mtime', async () => {
    const env = await setup();
    const name = sessionName('txlast');
    const { session } = await spawn(claudeSpawnOpts(env, name));
    CREATED.push(session.name);

    const transcript = join(claudeProjectDir(), `${name}.jsonl`);
    const { mtimeMs } = await stat(transcript);

    const entry = await entryOf(name, env);
    expect(entry?.lastActivityAt).toBeDefined();
    expect(Math.abs((entry?.lastActivityAt ?? 0) - mtimeMs)).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// status — state: what the worker is doing, in one word (umbel#71)
// ---------------------------------------------------------------------------

describe('status — state', () => {
  test('busy while a turn is open, idle once its stop lands', async () => {
    const env = await setup();
    const name = sessionName('statebi');
    const { session } = await spawn(
      // The worker hangs inside the turn, as one does during a long tool call.
      claudeSpawnOpts(env, name, { FAKE_CLAUDE_HANG_MS: '8000' }),
    );
    CREATED.push(session.name);

    await send({ name, prompt: 'work', env });

    expect(await waitForState(name, env, 'busy', 5000)).toBe('busy');
    // The hang ends, the turn closes, and the stop names it done.
    expect(await waitForState(name, env, 'idle', 15_000)).toBe('idle');
  }, 30_000);

  test('input when the worker is blocked on a person', async () => {
    const env = await setup();
    const name = sessionName('statein');
    const { session } = await spawn(claudeSpawnOpts(env, name));
    CREATED.push(session.name);
    const eventsDir = join(tmpDir, 'sessions', name, 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, 'notification'),
      `${JSON.stringify({ notification_type: 'permission_prompt', message: 'allow?' })}\n`,
    );

    const entry = await entryOf(name, env);
    expect(entry?.state).toBe('input');
    expect(entry?.needsInput).toBe(true);
  });

  test('dead once the worker is gone', async () => {
    const env = await setup();
    const name = sessionName('statedd');
    const { session } = await spawn(claudeSpawnOpts(env, name));
    CREATED.push(session.name);
    await kill({ name, env });

    expect((await entryOf(name, env))?.state).toBe('dead');

    await kill({ name, purge: true, env });
  });

  // A worker spawned by an older umbel carries no turn-start hook. Without the
  // signal there is no way to tell a turn in progress from an idle worker, so
  // the word stays the one that is certainly true.
  test('alive when the session records no turn-start signal', async () => {
    const env = await setup();
    const name = sessionName('stateal');
    const { session } = await spawn(claudeSpawnOpts(env, name));
    CREATED.push(session.name);

    const metaPath = join(tmpDir, 'sessions', name, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    delete meta.turnStartEvent;
    await writeFile(metaPath, JSON.stringify(meta));
    const eventsDir = join(tmpDir, 'sessions', name, 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, 'stop'), '');

    expect((await entryOf(name, env))?.state).toBe('alive');
  });
});

// ---------------------------------------------------------------------------
// status — the model the provider reports (umbel#69)
// ---------------------------------------------------------------------------

describe('status — reportedModel', () => {
  test("claude's statusline names the model from launch, before any turn", async () => {
    const env = await setup();
    const name = sessionName('mdlcl');
    const { session } = await spawn(claudeSpawnOpts(env, name));
    CREATED.push(session.name);

    // The real installed script, driven as claude drives it: payload on stdin.
    const { statusLineScriptPath } = await ensureGlobalHooks(env);
    const proc = Bun.spawn([statusLineScriptPath], {
      stdin: new TextEncoder().encode(
        JSON.stringify({ model: { id: 'claude-opus-5-5', display_name: 'Opus' } }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, UMBEL_STATE: tmpDir, UMBEL_SESSION_ID: session.name },
    });
    expect(await proc.exited).toBe(0);

    const entry = await entryOf(name, env);
    expect(entry?.model).toBeUndefined();
    expect(entry?.reportedModel).toBe('claude-opus-5-5');
  });

  test("the spawn's --model is the answer when one was given", async () => {
    const env = await setup();
    const name = sessionName('mdlsp');
    const { session } = await spawn({ ...claudeSpawnOpts(env, name), model: 'sonnet' });
    CREATED.push(session.name);

    const entry = await entryOf(name, env);
    expect(entry?.model).toBe('sonnet');
    expect(entry?.reportedModel).toBeUndefined();
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

// ---------------------------------------------------------------------------
// status — awaitingProviderSince (a model request out and unanswered)
// ---------------------------------------------------------------------------

describe('status — awaitingProviderSince', () => {
  const REQUEST_AT = '2026-10-21T19:27:24.799Z';

  // Same isolation as spawn: transcript discovery looks in the test's projects
  // root, never the real ~/.claude.
  const deps = (): NonNullable<Parameters<typeof status>[0]['deps']> => ({
    jsonl: {
      ...jsonlAdapter,
      discoverSessionJsonl: (opts) =>
        jsonlAdapter.discoverSessionJsonl({ ...opts, projectsRoot: projectsDir }),
    },
  });

  // The transcript status discovers for a claude worker in /tmp. Written where
  // discovery looks (the cwd is resolved before encoding), not where the fake
  // binary writes its own copy.
  async function writeTranscript(name: string, lines: string[]): Promise<string> {
    const path = join(projectsDir, jsonlAdapter.encodeCwd('/tmp'), `${name}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${lines.join('\n')}\n`);
    return path;
  }

  test('is the unanswered request time, and gone once the answer lands', async () => {
    const env = await setup();
    const name = sessionName('inflight');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    const path = await writeTranscript(name, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      JSON.stringify({
        type: 'api-request',
        timestamp: REQUEST_AT,
        querySource: 'repl_main_thread',
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'go' }),
    ]);

    const [waiting] = await status({ name, env, deps: deps() });
    expect(waiting?.awaitingProviderSince).toBe(REQUEST_AT);

    await appendFile(
      path,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
        },
      })}\n`,
    );

    const [answered] = await status({ name, env, deps: deps() });
    expect(answered?.awaitingProviderSince).toBeUndefined();
  });

  test('is absent for a worker with no transcript yet', async () => {
    const env = await setup();
    const name = sessionName('nojsonl');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    const [entry] = await status({ name, env, deps: deps() });
    expect(entry?.awaitingProviderSince).toBeUndefined();
  });

  // status reads the same transcript read does. After a /clear the hook names a
  // new file while meta still caches the old one, and the request in flight is
  // in the new one (umbel#141).
  test('reads the transcript the newest Stop hook named, not the one meta cached', async () => {
    const env = await setup();
    const name = sessionName('recached');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    const cachedPath = join(projectsDir, 'cached', `${name}.jsonl`);
    await mkdir(dirname(cachedPath), { recursive: true });
    await writeFile(
      cachedPath,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'before /clear' }],
          stop_reason: 'end_turn',
        },
      })}\n`,
    );
    const metaPath = join(tmpDir, 'sessions', name, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    await writeFile(metaPath, JSON.stringify({ ...meta, jsonlPath: cachedPath }));

    const hookedPath = await writeTranscript(name, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      JSON.stringify({
        type: 'api-request',
        timestamp: REQUEST_AT,
        querySource: 'repl_main_thread',
      }),
    ]);
    const eventsDir = join(tmpDir, 'sessions', name, 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, 'transcript-path'), hookedPath);

    const [waiting] = await status({ name, env, deps: deps() });
    expect(waiting?.awaitingProviderSince).toBe(REQUEST_AT);
  });
});

// ---------------------------------------------------------------------------
// Quota — the statusLine payload becomes state a caller can branch on
// ---------------------------------------------------------------------------

describe('status — subscription quota', () => {
  test('the installed statusline script turns a payload into a quota field', async () => {
    const env = await setup();
    const name = sessionName('quota');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    // Drive the real installed script the way claude does: payload on stdin,
    // session identified by env. Nothing here is a stand-in for umbel's code.
    const { statusLineScriptPath } = await ensureGlobalHooks(env);
    const proc = Bun.spawn([statusLineScriptPath], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          model: { display_name: 'Opus' },
          rate_limits: { five_hour: { used_percentage: 94, resets_at: '2026-09-05T21:20:00Z' } },
        }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, UMBEL_STATE: tmpDir, UMBEL_SESSION_ID: session.name },
    });
    expect(await proc.exited).toBe(0);

    const [entry] = await status({ name: session.name, env });
    expect(entry?.quota).toEqual({ fiveHourPct: 94, resetsAt: '2026-09-05T21:20:00Z' });
  });

  test('a worker with no reported limits carries no quota field', async () => {
    const env = await setup();
    const name = sessionName('noquota');
    const { session } = await spawn(makeSpawnOpts(env, '/tmp', { name }));
    CREATED.push(session.name);

    const [entry] = await status({ name: session.name, env });
    expect(entry?.quota).toBeUndefined();
  });
});
