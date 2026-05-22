import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STOP_HOOK_SCRIPT,
  buildSettingsJson,
  ensureGlobalHooks,
} from '../../src/adapters/hooks.ts';

let tmpDir: string;

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-hooks-test-'));
  return { RCTRL_STATE: tmpDir };
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
    const scriptPath = '/home/user/.rctrl/hooks/stop.sh';
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
});

describe('STOP_HOOK_SCRIPT', () => {
  test('is a string starting with shebang', () => {
    expect(typeof STOP_HOOK_SCRIPT).toBe('string');
    expect(STOP_HOOK_SCRIPT.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('references RCTRL_STATE and RCTRL_SESSION_ID env vars', () => {
    expect(STOP_HOOK_SCRIPT).toContain('RCTRL_STATE');
    expect(STOP_HOOK_SCRIPT).toContain('RCTRL_SESSION_ID');
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
        RCTRL_STATE: tmpDir,
        RCTRL_SESSION_ID: sessionId,
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
