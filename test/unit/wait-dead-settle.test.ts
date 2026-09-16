import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaneState } from '../../src/adapters/tmux.ts';
import { waitFor } from '../../src/operations/wait.ts';

// ---------------------------------------------------------------------------
// A pane's death reaches tmux in two steps: the pty closes (pane_dead = 1) and,
// moments later, the child is reaped and its status or signal recorded. On
// ubuntu's tmux 3.4 the liveness probe landed between the two and umbel settled
// `dead` with nothing recorded (jahala/umbel#89, CI on 5d8ceba), while the
// status was there a moment later (probe run 35047549038). The dead path must
// give tmux that moment.
// ---------------------------------------------------------------------------

let tmpDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-deadsettle-'));
  return { UMBEL_STATE: tmpDir };
}

async function cleanup(): Promise<void> {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
}

// A tmux whose pane reports dead at once and its status only from the Nth read.
function tmuxRecordingStatusLate(after: number, recorded: Partial<PaneState>) {
  let reads = 0;
  return {
    reads: () => reads,
    tmux: {
      paneState: async (): Promise<PaneState> => {
        reads += 1;
        return reads > after
          ? { exists: true, dead: true, ...recorded }
          : { exists: true, dead: true };
      },
      capturePane: async () => 'dying now',
    },
  };
}

describe('waitFor — a death settles only once tmux has recorded how', () => {
  test('an exit status recorded a few reads after the pane died is carried', async () => {
    const env = await setup();
    try {
      const late = tmuxRecordingStatusLate(3, { exitCode: 3 });
      const result = await waitFor({
        name: 'late-status',
        env,
        defaultTimeoutMs: 10_000,
        deps: { tmux: late.tmux } as never,
      });

      expect(result.reason).toBe('dead');
      expect(result.exitCode).toBe(3);
      expect(result.message).toBe('process exited 3');
      expect(late.reads()).toBeGreaterThan(3);
    } finally {
      await cleanup();
    }
  });

  test('a signal recorded late, as a number, reads as its name', async () => {
    const env = await setup();
    try {
      const late = tmuxRecordingStatusLate(2, { signal: '15' });
      const result = await waitFor({
        name: 'late-signal',
        env,
        defaultTimeoutMs: 10_000,
        deps: { tmux: late.tmux } as never,
      });

      expect(result.reason).toBe('dead');
      expect(result.exitCode).toBeUndefined();
      expect(result.message).toBe('killed by SIGTERM');
    } finally {
      await cleanup();
    }
  });

  test('a death tmux never records settles anyway, within a bounded grace', async () => {
    const env = await setup();
    try {
      const never = tmuxRecordingStatusLate(Number.POSITIVE_INFINITY, {});
      const started = Date.now();
      const result = await waitFor({
        name: 'never-status',
        env,
        defaultTimeoutMs: 10_000,
        deps: { tmux: never.tmux } as never,
      });

      expect(result.reason).toBe('dead');
      expect(result.message).toBe('process exited, tmux recorded no status');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await cleanup();
    }
  });
});
