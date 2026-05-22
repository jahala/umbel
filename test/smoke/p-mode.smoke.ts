import { afterEach, expect, test } from 'bun:test';
import { makeCleanupGuard, runCli, smokeDescribe, smokeName } from './helpers.ts';

// ---------------------------------------------------------------------------
// p-mode smoke tests
// ---------------------------------------------------------------------------

smokeDescribe('p-mode round-trip', () => {
  const guard = makeCleanupGuard();
  afterEach(() => guard.cleanup());

  test('rctrl -p --model haiku positional prompt exits 0 and stdout contains OK', async () => {
    // Validates: Stop hook fires from real claude, JSONL is readable, stdout is printed
    const name = smokeName('pm1');
    guard.register(name);

    const r = await runCli([
      '-p',
      '--model',
      'haiku',
      '--name',
      name,
      'Reply with exactly the word: OK',
    ]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toContain('OK');
  }, 120_000);

  test('rctrl -p --model haiku reads prompt from stdin and exits 0', async () => {
    // Validates: stdin pipe path through runPMode reads correctly; Stop hook fires
    const r = await runCli(['-p', '--model', 'haiku'], 'Reply with exactly the word: OK\n');

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toContain('OK');
  }, 120_000);
});
