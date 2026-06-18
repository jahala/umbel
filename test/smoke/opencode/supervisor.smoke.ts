import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCleanupGuard, runCli, smokeDescribeFor, smokeName } from '../helpers.ts';

// ---------------------------------------------------------------------------
// OpenCode supervisor verb smoke tests
//
// Uses the free, keyless OpenCode Zen model (opencode/big-pickle) → $0, no auth
// required. Isolates XDG_CONFIG_HOME to a tmpdir so the one-time global-plugin
// install never touches the developer's real ~/.config/opencode.
// ---------------------------------------------------------------------------

smokeDescribeFor('opencode', 'opencode supervisor spawn/send/wait/read/kill lifecycle', () => {
  const guard = makeCleanupGuard();
  let prevXdg: string | undefined;
  let restoreXdg = false;

  afterEach(async () => {
    await guard.cleanup();
    if (restoreXdg) {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      restoreXdg = false;
    }
  });

  test('opencode spawn → send → wait → read → kill (free model, plugin-based stop)', async () => {
    // Validates: tmux lifecycle, the global stop-plugin install + its firing on
    // session.status idle (no shell hook), and the `opencode export` read path.
    const tmpDir = await mkdtemp(join(tmpdir(), 'umbel-smoke-oc-sup-'));
    const cfgDir = await mkdtemp(join(tmpdir(), 'umbel-smoke-oc-cfg-'));
    prevXdg = process.env.XDG_CONFIG_HOME;
    restoreXdg = true;
    process.env.XDG_CONFIG_HOME = cfgDir; // isolate plugin install from real ~/.config

    const name = smokeName('oc-sup');
    guard.register(name);

    const spawnResult = await runCli([
      'spawn',
      '--provider',
      'opencode',
      '--model',
      'opencode/big-pickle',
      '--name',
      name,
      '--cwd',
      tmpDir,
    ]);
    expect(spawnResult.code).toBe(0);
    expect(spawnResult.stdout).toContain(name);

    const sendResult = await runCli(['send', name, 'reply with exactly one word: HELLO']);
    expect(sendResult.code).toBe(0);

    const waitResult = await runCli(['wait', name, '--timeout', '90s']);
    expect(waitResult.code).toBe(0);

    const readResult = await runCli(['read', name]);
    expect(readResult.code).toBe(0);
    expect(readResult.stdout.toUpperCase()).toContain('HELLO');

    const killResult = await runCli(['kill', name]);
    expect(killResult.code).toBe(0);

    const lsResult = await runCli(['ls']);
    expect(lsResult.stdout).not.toContain(name);
  }, 120_000);
});
