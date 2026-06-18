import { afterEach, expect, test } from 'bun:test';
import { makeCleanupGuard, runCli, smokeDescribe, smokeName } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Resume smoke test
// ---------------------------------------------------------------------------

smokeDescribe('p-mode --resume re-uses conversation context', () => {
  const guard = makeCleanupGuard();

  afterEach(() => guard.cleanup());

  test('second umbel -p --resume recalls codeword from first turn', async () => {
    // Validates: --name persists session, --resume attaches to existing session,
    // claude conversation context survives across umbel invocations
    const name = smokeName('rsm');
    guard.register(name);

    const first = await runCli([
      '-p',
      '--model',
      'haiku',
      '--name',
      name,
      'Please remember the codeword GINKO. Reply OK only.',
    ]);
    expect(first.code).toBe(0);

    const second = await runCli([
      '-p',
      '--model',
      'haiku',
      '--resume',
      name,
      'What was the codeword? Reply with just the codeword.',
    ]);
    expect(second.code).toBe(0);
    expect(second.stdout.toUpperCase()).toContain('GINKO');

    await runCli(['kill', name]);
  }, 120_000);
});
