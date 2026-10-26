import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BIND_HOOK_SCRIPT,
  ensureGlobalHooks,
  NOTIFY_HOOK_SCRIPT,
  STOP_HOOK_SCRIPT,
} from '../../src/adapters/hooks.ts';
import { buildSettingsJson } from '../../src/core/providers/claude-settings.ts';

let tmpDir: string;

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-hooks-test-'));
  return { UMBEL_STATE: tmpDir };
}

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

describe('buildSettingsJson', () => {
  test('produces parseable JSON', () => {
    const json = buildSettingsJson({ hookScriptPath: '/tmp/stop.sh' });
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('contains Stop hook with command path', () => {
    const scriptPath = '/home/user/.umbel/hooks/stop.sh';
    const json = buildSettingsJson({ hookScriptPath: scriptPath });
    const obj = JSON.parse(json) as Record<string, unknown>;
    const jsonStr = JSON.stringify(obj);
    expect(jsonStr).toContain(scriptPath);
    expect(jsonStr).toContain('Stop');
  });

  test('hooks block has expected shape for Claude Code', () => {
    const json = buildSettingsJson({ hookScriptPath: '/stop.sh' });
    const obj = JSON.parse(json) as { hooks?: { Stop?: unknown[] } };
    expect(obj.hooks).toBeDefined();
    expect(Array.isArray(obj.hooks?.Stop)).toBe(true);
    // Must have at least one hook entry
    expect((obj.hooks?.Stop ?? []).length).toBeGreaterThan(0);
  });

  test('with allowedTools includes permissions block', () => {
    const json = buildSettingsJson({
      hookScriptPath: '/stop.sh',
      allowedTools: 'Read,Write,Bash',
    });
    const obj = JSON.parse(json) as Record<string, unknown>;
    const jsonStr = JSON.stringify(obj);
    expect(jsonStr).toContain('Read');
    expect(jsonStr).toContain('Write');
    expect(jsonStr).toContain('Bash');
  });

  test('without allowedTools does not include permissions block', () => {
    const json = buildSettingsJson({ hookScriptPath: '/stop.sh' });
    const obj = JSON.parse(json) as Record<string, unknown>;
    // Should not have allowedTools / permissions key if not specified
    expect(JSON.stringify(obj)).not.toContain('allowedTools');
  });

  test('with notifyScriptPath includes a Notification block for permission + idle prompts', () => {
    const notify = '/home/user/.umbel/hooks/notify.sh';
    const json = buildSettingsJson({ hookScriptPath: '/stop.sh', notifyScriptPath: notify });
    const obj = JSON.parse(json) as { hooks?: { Notification?: Array<{ matcher?: string }> } };
    expect(Array.isArray(obj.hooks?.Notification)).toBe(true);
    const matchers = (obj.hooks?.Notification ?? []).map((n) => n.matcher);
    expect(matchers).toContain('permission_prompt');
    expect(matchers).toContain('idle_prompt');
    expect(json).toContain(notify);
  });

  test('without notifyScriptPath has no Notification block', () => {
    const json = buildSettingsJson({ hookScriptPath: '/stop.sh' });
    const obj = JSON.parse(json) as { hooks?: { Notification?: unknown } };
    expect(obj.hooks?.Notification).toBeUndefined();
  });
});

describe('STOP_HOOK_SCRIPT', () => {
  test('is a string starting with shebang', () => {
    expect(typeof STOP_HOOK_SCRIPT).toBe('string');
    expect(STOP_HOOK_SCRIPT.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('references UMBEL_STATE and UMBEL_SESSION_ID env vars', () => {
    expect(STOP_HOOK_SCRIPT).toContain('UMBEL_STATE');
    expect(STOP_HOOK_SCRIPT).toContain('UMBEL_SESSION_ID');
  });

  test('touches events/stop and appends to events/log', () => {
    expect(STOP_HOOK_SCRIPT).toContain('events/stop');
    expect(STOP_HOOK_SCRIPT).toContain('events/log');
  });
});

describe('ensureGlobalHooks', () => {
  test('creates stop.sh at expected path', async () => {
    const env = await setup();
    const { stopScriptPath } = await ensureGlobalHooks(env);
    expect(stopScriptPath).toContain('hooks/stop.sh');
    const s = await stat(stopScriptPath);
    expect(s.isFile()).toBe(true);
  });

  test('stop.sh is executable', async () => {
    const env = await setup();
    const { stopScriptPath } = await ensureGlobalHooks(env);
    const s = await stat(stopScriptPath);
    // mode 0o111 = all execute bits
    expect(s.mode & 0o111).toBeGreaterThan(0);
  });

  test('is idempotent — second call does not throw', async () => {
    const env = await setup();
    await ensureGlobalHooks(env);
    await expect(ensureGlobalHooks(env)).resolves.toBeDefined();
  });

  test('stop.sh fires correctly when executed with env set', async () => {
    const env = await setup();
    const { stopScriptPath } = await ensureGlobalHooks(env);

    // Create a session dir as the hook expects
    const sessionId = 'test-session-hook';
    const sessionEventsDir = join(tmpDir, 'sessions', sessionId, 'events');
    await mkdir(sessionEventsDir, { recursive: true });

    const proc = Bun.spawn(['bash', stopScriptPath], {
      env: {
        UMBEL_STATE: tmpDir,
        UMBEL_SESSION_ID: sessionId,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // events/stop must exist
    const stopFile = join(sessionEventsDir, 'stop');
    const stopStat = await stat(stopFile);
    expect(stopStat.isFile()).toBe(true);

    // events/log must have at least one line
    const logContent = await Bun.file(join(sessionEventsDir, 'log')).text();
    expect(logContent.trim().length).toBeGreaterThan(0);
    // Should be a nanosecond timestamp (large integer)
    const ts = logContent.trim().split('\n')[0];
    expect(ts).toMatch(/^\d+$/);
  });
});

describe('NOTIFY_HOOK_SCRIPT', () => {
  test('is a string starting with shebang', () => {
    expect(typeof NOTIFY_HOOK_SCRIPT).toBe('string');
    expect(NOTIFY_HOOK_SCRIPT.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('writes the message to events/notification', () => {
    expect(NOTIFY_HOOK_SCRIPT).toContain('events/notification');
    expect(NOTIFY_HOOK_SCRIPT).toContain('UMBEL_SESSION_ID');
  });
});

describe('ensureGlobalHooks — notify.sh', () => {
  test('creates an executable notify.sh', async () => {
    const env = await setup();
    const { notifyScriptPath } = await ensureGlobalHooks(env);
    expect(notifyScriptPath).toContain('hooks/notify.sh');
    const s = await stat(notifyScriptPath);
    expect(s.isFile()).toBe(true);
    expect(s.mode & 0o111).toBeGreaterThan(0);
  });

  test('notify.sh writes the payload message to events/notification', async () => {
    const env = await setup();
    const { notifyScriptPath } = await ensureGlobalHooks(env);
    const sessionId = 'test-session-notify';
    const sessionEventsDir = join(tmpDir, 'sessions', sessionId, 'events');
    await mkdir(sessionEventsDir, { recursive: true });

    const proc = Bun.spawn(['bash', notifyScriptPath], {
      env: { UMBEL_STATE: tmpDir, UMBEL_SESSION_ID: sessionId },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write(
      JSON.stringify({ message: 'Allow Bash(rm)?', notification_type: 'permission_prompt' }),
    );
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);

    const notif = await Bun.file(join(sessionEventsDir, 'notification')).text();
    expect(notif).toContain('Allow Bash(rm)?');
  });

  test('appends one JSON line per event (no clobber)', async () => {
    const env = await setup();
    const { notifyScriptPath } = await ensureGlobalHooks(env);
    const sessionId = 'test-notify-jsonl';
    const sessionEventsDir = join(tmpDir, 'sessions', sessionId, 'events');
    await mkdir(sessionEventsDir, { recursive: true });

    const fire = async (payload: object): Promise<void> => {
      const proc = Bun.spawn(['bash', notifyScriptPath], {
        env: { UMBEL_STATE: tmpDir, UMBEL_SESSION_ID: sessionId },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write(JSON.stringify(payload));
      await proc.stdin.end();
      await proc.exited;
    };

    await fire({
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
    });
    await fire({
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });

    const content = await Bun.file(join(sessionEventsDir, 'notification')).text();
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2); // appended, not clobbered
    expect(JSON.parse(lines[0] ?? '{}').notification_type).toBe('permission_prompt');
    expect(JSON.parse(lines[1] ?? '{}').notification_type).toBe('idle_prompt');
  });
});

// ---------------------------------------------------------------------------
// Worker identity (jahala/umbel#118)
// ---------------------------------------------------------------------------

async function fire(
  scriptPath: string,
  sessionId: string,
  payload: object,
  args: string[] = [],
): Promise<number | null> {
  const proc = Bun.spawn(['bash', scriptPath, ...args], {
    env: { UMBEL_STATE: tmpDir, UMBEL_SESSION_ID: sessionId },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  return await proc.exited;
}

const sessionEvents = (sessionId: string): string => join(tmpDir, 'sessions', sessionId, 'events');

const stopPayload = (sessionId: string, transcript: string): object => ({
  session_id: sessionId,
  transcript_path: transcript,
  hook_event_name: 'Stop',
});

describe('BIND_HOOK_SCRIPT and identity', () => {
  test('is a string starting with shebang and names the binding file', () => {
    expect(BIND_HOOK_SCRIPT.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(BIND_HOOK_SCRIPT).toContain('events/worker-session');
  });

  test('buildSettingsJson registers SessionStart with the bind script', () => {
    const bind = '/home/user/.umbel/hooks/bind.sh';
    const json = buildSettingsJson({ hookScriptPath: '/stop.sh', bindScriptPath: bind });
    const obj = JSON.parse(json) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    expect(Array.isArray(obj.hooks?.SessionStart)).toBe(true);
    const commands = (obj.hooks?.SessionStart ?? []).flatMap((g) =>
      (g.hooks ?? []).map((h) => h.command),
    );
    // Only the worker's own claude runs umbel's settings, so its SessionStart
    // may rebind: /clear starts a new session id in the same worker.
    expect(commands).toContain(`${bind} rebind`);
  });

  test('buildSettingsJson without a bind script has no SessionStart block', () => {
    const obj = JSON.parse(buildSettingsJson({ hookScriptPath: '/stop.sh' })) as {
      hooks?: { SessionStart?: unknown };
    };
    expect(obj.hooks?.SessionStart).toBeUndefined();
  });

  test('ensureGlobalHooks creates an executable bind.sh', async () => {
    const env = await setup();
    const { bindScriptPath } = await ensureGlobalHooks(env);
    expect(bindScriptPath).toContain('hooks/bind.sh');
    const s = await stat(bindScriptPath);
    expect(s.isFile()).toBe(true);
    expect(s.mode & 0o111).toBeGreaterThan(0);
  });

  test('bind.sh records the worker id once and never replaces it', async () => {
    const env = await setup();
    const { bindScriptPath } = await ensureGlobalHooks(env);
    const sessionId = 'worker-own';
    await mkdir(sessionEvents(sessionId), { recursive: true });

    const start = { session_id: 'ses_own', hook_event_name: 'SessionStart' };
    expect(await fire(bindScriptPath, sessionId, start)).toBe(0);
    expect(await Bun.file(join(sessionEvents(sessionId), 'worker-session')).text()).toBe('ses_own');

    const later = { session_id: 'ses_nested', hook_event_name: 'SessionStart' };
    expect(await fire(bindScriptPath, sessionId, later)).toBe(0);
    expect(await Bun.file(join(sessionEvents(sessionId), 'worker-session')).text()).toBe('ses_own');
  });

  test('bind.sh rebind replaces the id, for a CLI whose start event only the worker fires', async () => {
    const env = await setup();
    const { bindScriptPath } = await ensureGlobalHooks(env);
    const sessionId = 'worker-cleared';
    await mkdir(sessionEvents(sessionId), { recursive: true });

    await fire(bindScriptPath, sessionId, { session_id: 'ses_before_clear' }, ['rebind']);
    await fire(bindScriptPath, sessionId, { session_id: 'ses_after_clear' }, ['rebind']);
    expect(await Bun.file(join(sessionEvents(sessionId), 'worker-session')).text()).toBe(
      'ses_after_clear',
    );
  });

  test('stop.sh ignores a stop from another session once bound', async () => {
    const env = await setup();
    const { stopScriptPath, bindScriptPath } = await ensureGlobalHooks(env);
    const sessionId = 'worker-bound';
    await mkdir(sessionEvents(sessionId), { recursive: true });
    await fire(bindScriptPath, sessionId, { session_id: 'ses_own' });

    expect(await fire(stopScriptPath, sessionId, stopPayload('ses_nested', '/nested.jsonl'))).toBe(
      0,
    );

    const events = sessionEvents(sessionId);
    expect(await Bun.file(join(events, 'stop')).exists()).toBe(false);
    expect(await Bun.file(join(events, 'transcript-path')).exists()).toBe(false);
    expect(await Bun.file(join(events, 'log')).exists()).toBe(false);
  });

  test('stop.sh fires for the bound session', async () => {
    const env = await setup();
    const { stopScriptPath, bindScriptPath } = await ensureGlobalHooks(env);
    const sessionId = 'worker-match';
    await mkdir(sessionEvents(sessionId), { recursive: true });
    await fire(bindScriptPath, sessionId, { session_id: 'ses_own' });

    expect(await fire(stopScriptPath, sessionId, stopPayload('ses_own', '/own.jsonl'))).toBe(0);

    const events = sessionEvents(sessionId);
    expect(await Bun.file(join(events, 'stop')).exists()).toBe(true);
    expect((await Bun.file(join(events, 'transcript-path')).text()).trim()).toBe('/own.jsonl');
  });

  test('notify.sh ignores another session notification once bound', async () => {
    const env = await setup();
    const { notifyScriptPath, bindScriptPath } = await ensureGlobalHooks(env);
    const sessionId = 'worker-notify';
    await mkdir(sessionEvents(sessionId), { recursive: true });
    await fire(bindScriptPath, sessionId, { session_id: 'ses_own' });

    await fire(notifyScriptPath, sessionId, {
      session_id: 'ses_nested',
      notification_type: 'permission_prompt',
      message: 'nested asks for permission',
    });
    expect(await Bun.file(join(sessionEvents(sessionId), 'notification')).exists()).toBe(false);

    await fire(notifyScriptPath, sessionId, {
      session_id: 'ses_own',
      notification_type: 'permission_prompt',
      message: 'worker asks for permission',
    });
    const notif = await Bun.file(join(sessionEvents(sessionId), 'notification')).text();
    expect(notif).toContain('worker asks for permission');
  });
});
