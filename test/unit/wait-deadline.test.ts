import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionNameSchema } from '../../src/core/types.ts';
import { deadlineOf } from '../../src/core/wait.ts';
import { DEADLINE_GRACE_MS, waitFor } from '../../src/operations/wait.ts';

// ---------------------------------------------------------------------------
// umbel#98: a wait asked for 120s blocked for 46 minutes on a worker sitting at
// a login menu. The deadline was reported only when a check finished, and a
// check awaits tmux calls. When tmux does not answer, nothing ends the wait.
// Whatever the pane and tmux do, the deadline ends it.
// ---------------------------------------------------------------------------

let tmpDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-deadline-'));
  return { UMBEL_STATE: tmpDir };
}

async function cleanup(): Promise<void> {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('waitFor: the deadline ends the wait', () => {
  test('while every tmux call hangs', async () => {
    const env = await setup();
    try {
      const started = Date.now();
      const result = await waitFor({
        name: 'hung-tmux',
        env,
        defaultTimeoutMs: 300,
        deps: { tmux: { paneState: never, capturePane: never } } as never,
      });

      expect(result.reason).toBe('timeout');
      expect(result.message).toContain('tmux did not answer');
      expect(Date.now() - started).toBeLessThan(300 + DEADLINE_GRACE_MS + 1_000);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('with the last pane seen alive when the capture at the deadline hangs', async () => {
    const env = await setup();
    try {
      let captures = 0;
      const result = await waitFor({
        name: 'hung-capture',
        env,
        defaultTimeoutMs: 300,
        deps: {
          tmux: {
            paneState: async () => ({ exists: true, dead: false }),
            // The alive view is taken once, then tmux stops answering.
            capturePane: () =>
              captures++ === 0 ? Promise.resolve('Sign in to continue') : never(),
          },
        } as never,
      });

      expect(result.reason).toBe('timeout');
      expect(result.paneSnapshot).toBe('Sign in to continue');
    } finally {
      await cleanup();
    }
  }, 10_000);
});

describe('deadlineOf', () => {
  test('is the timeout at the top, or inside any', () => {
    expect(deadlineOf({ kind: 'timeout', ms: 5 })).toBe(5);
    expect(
      deadlineOf({
        kind: 'any',
        conditions: [
          { kind: 'stop', session: SessionNameSchema.parse('w'), sinceMtime: 0 },
          { kind: 'timeout', ms: 9 },
          { kind: 'any', conditions: [{ kind: 'timeout', ms: 7 }] },
        ],
      }),
    ).toBe(7);
  });

  test('is absent for a timer inside all, which only asks for time to pass', () => {
    expect(
      deadlineOf({
        kind: 'all',
        conditions: [
          { kind: 'file', path: '/tmp/x' },
          { kind: 'timeout', ms: 5 },
        ],
      }),
    ).toBeUndefined();
  });
});
