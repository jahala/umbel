import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCleanupGuard, runCli, smokeDescribe, smokeName } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Multi-line prompt smoke test
// ---------------------------------------------------------------------------

smokeDescribe('multiline prompt via paste-buffer', () => {
  const guard = makeCleanupGuard();

  afterEach(() => guard.cleanup());

  test('three-line prompt sent via paste-buffer yields coherent response', async () => {
    // Validates: tmux load-buffer + paste-buffer path for prompts containing \n
    const tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-smoke-ml-'));
    const name = smokeName('ml');
    guard.register(name);

    const spawnResult = await runCli([
      'spawn',
      '--name',
      name,
      '--cwd',
      tmpDir,
      '--model',
      'haiku',
    ]);
    expect(spawnResult.code).toBe(0);

    const multiLinePrompt = [
      'Please count the lines in this prompt and reply with just the digit.',
      'Line two.',
      'Line three.',
    ].join('\n');

    const sendResult = await runCli(['send', name, multiLinePrompt]);
    expect(sendResult.code).toBe(0);

    const waitResult = await runCli(['wait', name, '--timeout', '90s']);
    expect(waitResult.code).toBe(0);

    const readResult = await runCli(['read', name]);
    expect(readResult.code).toBe(0);
    expect(readResult.stdout).toContain('3');

    await runCli(['kill', name]);
  }, 120_000);
});
