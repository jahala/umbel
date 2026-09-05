import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePane, hasSession } from '../../../src/adapters/tmux.ts';
import { makeCleanupGuard, runCli, smokeDescribe, smokeName } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Startup-dialog dismissal against the installed Claude Code.
//
// This exists because the trust matcher silently rotted: it was written when
// the highlighted default was "Yes, I trust this folder", the release changed
// it to "No, exit", and umbel went on pressing Enter — killing every worker
// spawned into an untrusted repository. Nothing caught it, because the fake
// fixture shows no dialogs and the unit tests assert against pane text we
// wrote ourselves. Only the real binary can say whether the matchers still fit.
//
// Trust is keyed per repository path, so a fresh clone is always untrusted and
// always raises the prompt. Answering it writes an entry to the user's
// ~/.claude.json for that temp path — unavoidable, since the point is to drive
// the real dialog.
// ---------------------------------------------------------------------------

async function untrustedClone(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'umbel-smoke-trust-')), 'repo');
  const repoRoot = new URL('../../../', import.meta.url).pathname;
  const proc = Bun.spawn(['git', 'clone', '--quiet', '--no-hardlinks', repoRoot, dir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`clone failed: ${await new Response(proc.stderr).text()}`);
  }
  return dir;
}

smokeDescribe('claude startup dialogs', () => {
  const guard = makeCleanupGuard();
  afterEach(() => guard.cleanup());

  test('a worker spawned into an untrusted repo survives and reaches the main UI', async () => {
    const cwd = await untrustedClone();
    const name = smokeName('trust');
    guard.register(name);

    const r = await runCli(['spawn', '--name', name, '--cwd', cwd, '--unattended']);
    expect(r.code).toBe(0);

    // Alive is the first thing the old matcher broke: Enter on "No, exit" quit
    // Claude outright, and spawn's own session check then reported it gone.
    expect(await hasSession(name)).toBe(true);

    // Alive is not enough — a swallowed keystroke leaves the worker parked on
    // the dialog, which looks healthy until the wait deadline. Assert the
    // dialog is actually gone and the main UI rendered.
    const pane = await capturePane(name, 40);
    expect(pane).not.toMatch(/No, exit|Yes, I trust this folder/);
    expect(pane).toMatch(/Try |for shortcuts/);
  }, 90_000);
});
