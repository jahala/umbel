import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { send } from '../../src/operations/send.ts';

// ---------------------------------------------------------------------------
// send() must thread the provider's submitDelayMs into tmux.sendText so the
// submitting Enter waits long enough for the provider's TUI to ingest the
// pasted text. Both TUIs drop an immediate Enter while their startup work is
// still settling: the prompt sits unsent (codex #77, claude #121). Verified
// against the real binaries.
// ---------------------------------------------------------------------------

interface SendTextCall {
  name: string;
  text: string;
  opts?: { submitDelayMs?: number };
}

const DIRS: string[] = [];

afterEach(async () => {
  await Promise.all(DIRS.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeDeps(provider: string, calls: SendTextCall[]) {
  const eventsDir = await mkdtemp(join(tmpdir(), 'umbel-send-delay-'));
  DIRS.push(eventsDir);
  return {
    fs: {
      // send() reads meta to learn the provider, and computes eventsDir for
      // the stop and turn-start mtime snapshots.
      readMeta: async () => ({ name: 's', cwd: '/tmp', provider, jsonlPath: null }),
      eventsDir: () => eventsDir,
    },
    tmux: {
      // Liveness is read from the worker's pane, not its session.
      paneState: async () => ({ exists: true, dead: false }),
      sendText: async (name: string, text: string, opts?: { submitDelayMs?: number }) => {
        calls.push({ name, text, ...(opts !== undefined ? { opts } : {}) });
        // The submitted prompt started a turn: the provider's hook touches it.
        await writeFile(join(eventsDir, 'turn-start'), '');
      },
      // The prompt was taken: nothing pending, so send confirms and returns.
      capturePane: async () => '• Working\n',
    },
  };
}

describe('send — submitDelayMs threading', () => {
  test('codex session → sendText receives codex submitDelayMs', async () => {
    const calls: SendTextCall[] = [];
    await send({
      name: 's',
      prompt: 'hello',
      env: { UMBEL_STATE: '/tmp/x' },
      deps: (await makeDeps('codex', calls)) as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('hello');
    expect(calls[0]?.opts?.submitDelayMs).toBe(CodexProvider.submitDelayMs);
    // Sanity: codex actually declares a positive delay (the whole point).
    expect(CodexProvider.submitDelayMs).toBeGreaterThan(0);
  });

  test('claude session → sendText receives claude submitDelayMs', async () => {
    const calls: SendTextCall[] = [];
    await send({
      name: 's',
      prompt: 'hi',
      env: { UMBEL_STATE: '/tmp/x' },
      deps: (await makeDeps('claude', calls)) as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.submitDelayMs).toBe(ClaudeProvider.submitDelayMs);
    expect(ClaudeProvider.submitDelayMs).toBeGreaterThan(0);
  });
});
