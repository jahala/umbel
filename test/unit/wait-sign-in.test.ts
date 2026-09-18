import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionDir, writeMeta } from '../../src/adapters/fs-state.ts';
import { SessionSchema } from '../../src/core/types.ts';
import { waitFor } from '../../src/operations/wait.ts';

// ---------------------------------------------------------------------------
// umbel#105: a worker that reaches its CLI's sign-in screen after spawn, for
// instance when its credentials expire, is asking a person to act. The wait
// ended at its deadline as `timeout`, which a conductor retries, and the retry
// met the same screen. It settles `input`, with the line and the pane.
// ---------------------------------------------------------------------------

const signInPane = readFileSync(
  join(import.meta.dir, '../fixtures/sign-in/gemini-0.46.0-sign-in.txt'),
  'utf8',
);

describe('waitFor: a worker at its sign-in screen', () => {
  test('settles input with the line, long before the deadline', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'umbel-wait-sign-in-'));
    const env = { UMBEL_STATE: tmpDir };
    try {
      const name = 'signed-out';
      await ensureSessionDir(name, env);
      await writeMeta(
        name,
        SessionSchema.parse({
          name,
          cwd: '/tmp',
          anonymous: false,
          createdAt: Date.now(),
          jsonlPath: null,
          provider: 'gemini',
        }),
        env,
      );

      const started = Date.now();
      const result = await waitFor({
        name,
        env,
        defaultTimeoutMs: 20_000,
        deps: {
          tmux: {
            paneState: async () => ({ exists: true, dead: false }),
            capturePane: async () => signInPane,
          },
        } as never,
      });

      expect(result.reason).toBe('input');
      expect(result.inputReason).toBe('sign-in');
      expect(result.message).toContain('How would you like to authenticate for this project?');
      expect(result.paneSnapshot).toBe(signInPane);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a worker at work is left to finish', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'umbel-wait-sign-in-'));
    const env = { UMBEL_STATE: tmpDir };
    try {
      const name = 'working';
      await ensureSessionDir(name, env);
      await writeMeta(
        name,
        SessionSchema.parse({
          name,
          cwd: '/tmp',
          anonymous: false,
          createdAt: Date.now(),
          jsonlPath: null,
          provider: 'gemini',
        }),
        env,
      );

      const result = await waitFor({
        name,
        env,
        defaultTimeoutMs: 1_500,
        deps: {
          tmux: {
            paneState: async () => ({ exists: true, dead: false }),
            capturePane: async () => '✦ Reading the repository',
          },
        } as never,
      });

      expect(result.reason).toBe('timeout');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
