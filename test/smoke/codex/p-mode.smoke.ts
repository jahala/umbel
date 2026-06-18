import { afterEach, expect, test } from 'bun:test';
import { makeCleanupGuard, runCli, smokeDescribeFor, smokeName } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Codex p-mode smoke tests
// ---------------------------------------------------------------------------

smokeDescribeFor('codex', 'codex p-mode round-trip', () => {
  const guard = makeCleanupGuard();
  afterEach(() => guard.cleanup());

  test('umbel -p --provider codex positional prompt exits 0 and stdout contains OK', async () => {
    // Validates: Stop hook fires from real codex, JSONL is readable, stdout is printed
    const name = smokeName('cdx-pm1');
    guard.register(name);

    const r = await runCli([
      '-p',
      '--provider',
      'codex',
      '--name',
      name,
      'Reply with exactly the word: OK',
    ]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toContain('OK');
  }, 120_000);

  test('umbel -p --provider codex reads prompt from stdin and exits 0', async () => {
    // Validates: stdin pipe path through runPMode reads correctly; Stop hook fires
    const r = await runCli(['-p', '--provider', 'codex'], 'Reply with exactly the word: OK\n');

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toContain('OK');
  }, 120_000);
});
