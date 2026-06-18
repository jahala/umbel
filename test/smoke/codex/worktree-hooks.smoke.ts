import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCleanupGuard, runCli, smokeDescribeFor, smokeName } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Codex worktree Stop-hook smoke
//
// Regression: codex inside a LINKED git worktree reads its .codex/ hook config
// from the MAIN repo (an anti-escalation redirect), NOT the worktree itself. So
// umbel's worktree workers never fired Stop and `wait` hung to the timeout. The
// fix writes hooks to the main-repo .codex/ for worktree workers — proven here
// against the real binary: a codex worker in a `git worktree add --detach` dir
// must complete (wait → exit 0), not time out (124).
// ---------------------------------------------------------------------------

async function git(args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', '-c', 'user.email=umbel@test', '-c', 'user.name=umbel', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`);
}

smokeDescribeFor('codex', 'codex Stop hook fires inside a linked git worktree', () => {
  const guard = makeCleanupGuard();
  afterEach(() => guard.cleanup());

  test('a codex worker in a detached worktree completes (wait → stop, not timeout)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'umbel-smoke-cdx-wt-'));
    const main = join(base, 'main');
    const wt = join(base, 'wt');
    await git(['init', main]);
    await git(['-C', main, 'commit', '--allow-empty', '-m', 'init']);
    await git(['-C', main, 'worktree', 'add', '--detach', wt, 'HEAD']);

    const name = smokeName('cdx-wt');
    const spawnResult = await runCli(['spawn', '--provider', 'codex', '--name', name, '--cwd', wt]);
    expect(spawnResult.code).toBe(0);
    guard.register(name);

    const sendResult = await runCli(['send', name, 'Reply with exactly the word: ready']);
    expect(sendResult.code).toBe(0);

    // The crux: the Stop hook must fire from inside the worktree → wait exits 0.
    // (Before the fix this timed out at exit 124 with an empty events/ dir.)
    const waitResult = await runCli(['wait', name, '--timeout', '90s']);
    expect(waitResult.code).toBe(0);
  }, 150_000);
});
