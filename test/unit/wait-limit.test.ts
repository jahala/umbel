import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionDir, writeMeta } from '../../src/adapters/fs-state.ts';
import { SessionSchema } from '../../src/core/types.ts';
import { waitFor } from '../../src/operations/wait.ts';

// ---------------------------------------------------------------------------
// umbel#75: claude's usage-limit dialog fires the same Notification as an input
// prompt, so `wait` settled `input` with "Claude is waiting for your input".
// The dialog's own line, with the reset time, is what the caller needs to
// schedule a resume instead of quarantining the worker.
// ---------------------------------------------------------------------------

const HIT = "You've hit your session limit · resets 4:30pm (Europe/Copenhagen)";
const limitPane = readFileSync(
  join(import.meta.dir, '../fixtures/limit/claude-session-limit.txt'),
  'utf8',
);

async function workerAtLimit() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'umbel-wait-limit-'));
  const env = { UMBEL_STATE: tmpDir };
  const name = 'limited';
  await ensureSessionDir(name, env);
  await writeMeta(
    name,
    SessionSchema.parse({
      name,
      cwd: '/tmp',
      anonymous: false,
      createdAt: Date.now(),
      jsonlPath: null,
      provider: 'claude',
    }),
    env,
  );
  const notification = join(tmpDir, 'sessions', name, 'events', 'notification');
  return { tmpDir, env, name, notification };
}

function notifySoon(path: string): void {
  setTimeout(() => {
    const line = `${JSON.stringify({
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    })}\n`;
    writeFile(path, line).catch(() => undefined);
  }, 300);
}

const aliveTmux = (pane: string) =>
  ({
    paneState: async () => ({ exists: true, dead: false }),
    capturePane: async () => pane,
  }) as never;

describe('waitFor: a worker on its usage-limit dialog', () => {
  test('settles input with the dialog line and its reset time', async () => {
    const { tmpDir, env, name, notification } = await workerAtLimit();
    try {
      notifySoon(notification);

      const result = await waitFor({
        name,
        env,
        defaultTimeoutMs: 5_000,
        deps: { tmux: aliveTmux(limitPane) },
      });

      expect(result.reason).toBe('input');
      expect(result.inputReason).toBe('idle');
      expect(result.message).toBe(HIT);
      expect(result.paneSnapshot).toBe(limitPane);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('keeps the hook message when the pane shows no limit dialog', async () => {
    const { tmpDir, env, name, notification } = await workerAtLimit();
    try {
      notifySoon(notification);

      const result = await waitFor({
        name,
        env,
        defaultTimeoutMs: 5_000,
        deps: { tmux: aliveTmux('❯ Working on it') },
      });

      expect(result.reason).toBe('input');
      expect(result.message).toBe('Claude is waiting for your input');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
