import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../../src/operations/wait.ts';

// ---------------------------------------------------------------------------
// On timeout, waitFor captures a best-effort tmux pane snapshot so a stuck
// worker's cause is visible. Uses a tiny timeout + a fake tmux.capturePane;
// the stop condition never fires (events/stop never touched), so the wait
// times out and should carry the snapshot.
// ---------------------------------------------------------------------------

let tmpDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-waitdiag-'));
  return { RCTRL_STATE: tmpDir };
}

async function cleanup(): Promise<void> {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
}

describe('waitFor — timeout diagnostics', () => {
  test('timeout result carries a pane snapshot from tmux', async () => {
    const env = await setup();
    try {
      const PANE = 'Hooks need review\n1. Review hooks\n2. Trust all and continue';
      const result = await waitFor({
        name: 'stuck',
        env,
        defaultTimeoutMs: 60, // fast timeout — no stop event will arrive
        deps: {
          tmux: {
            capturePane: async () => PANE,
          },
        } as never,
      });

      expect(result.reason).toBe('timeout');
      expect(result.stopped).toBe(false);
      expect(result.paneSnapshot).toBe(PANE);
    } finally {
      await cleanup();
    }
  });

  test('capturePane failure → timeout still settles, snapshot absent', async () => {
    const env = await setup();
    try {
      const result = await waitFor({
        name: 'stuck2',
        env,
        defaultTimeoutMs: 60,
        deps: {
          tmux: {
            capturePane: async () => {
              throw new Error('tmux gone');
            },
          },
        } as never,
      });

      expect(result.reason).toBe('timeout');
      expect(result.paneSnapshot).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
