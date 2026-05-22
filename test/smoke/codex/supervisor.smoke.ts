import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCleanupGuard, runCli, smokeDescribeFor, smokeName } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Codex supervisor verb smoke tests
// ---------------------------------------------------------------------------

smokeDescribeFor('codex', 'codex supervisor spawn/send/wait/read/kill lifecycle', () => {
  const guard = makeCleanupGuard();
  let tmpDir = '';

  afterEach(async () => {
    await guard.cleanup();
    // tmpDir is small; leave OS to clean it
  });

  test('codex spawn → send → wait → read → kill completes cleanly', async () => {
    // Validates: tmux session lifecycle, send-keys delivery, Stop hook via .codex/hooks.json, JSONL discovery
    tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-smoke-cdx-sup-'));
    const name = smokeName('cdx-sup');
    guard.register(name);

    const spawnResult = await runCli([
      'spawn',
      '--provider',
      'codex',
      '--name',
      name,
      '--cwd',
      tmpDir,
    ]);
    expect(spawnResult.code).toBe(0);
    expect(spawnResult.stdout).toContain(name);

    const sendResult = await runCli(['send', name, 'say HELLO and nothing else']);
    expect(sendResult.code).toBe(0);

    const waitResult = await runCli(['wait', name, '--timeout', '90s']);
    expect(waitResult.code).toBe(0);

    const readResult = await runCli(['read', name]);
    expect(readResult.code).toBe(0);
    expect(readResult.stdout.toUpperCase()).toContain('HELLO');

    const killResult = await runCli(['kill', name]);
    expect(killResult.code).toBe(0);

    // Verify ls no longer lists the session
    const lsResult = await runCli(['ls']);
    expect(lsResult.stdout).not.toContain(name);
  }, 120_000);
});
