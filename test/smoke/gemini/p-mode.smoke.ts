import { afterEach, expect, test } from 'bun:test';
import { makeCleanupGuard, runCli, smokeDescribeFor, smokeName } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Gemini p-mode smoke tests
// ---------------------------------------------------------------------------

smokeDescribeFor('gemini', 'gemini p-mode round-trip', () => {
  const guard = makeCleanupGuard();
  afterEach(() => guard.cleanup());

  test('umbel -p --provider gemini positional prompt exits 0 and stdout contains OK', async () => {
    // Validates: AfterAgent hook fires from real gemini, JSONL is readable, stdout is printed
    const name = smokeName('gem-pm1');
    guard.register(name);

    const r = await runCli([
      '-p',
      '--provider',
      'gemini',
      '--name',
      name,
      'Reply with exactly the word: OK',
    ]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toContain('OK');
  }, 120_000);

  test('umbel -p --provider gemini reads prompt from stdin and exits 0', async () => {
    // Validates: stdin pipe path through runPMode reads correctly; AfterAgent hook fires
    const r = await runCli(['-p', '--provider', 'gemini'], 'Reply with exactly the word: OK\n');

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toContain('OK');
  }, 120_000);
});
