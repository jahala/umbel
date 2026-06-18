import { describe, expect, test } from 'bun:test';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { send } from '../../src/operations/send.ts';

// ---------------------------------------------------------------------------
// send() must thread the provider's submitDelayMs into tmux.sendText so the
// submitting Enter waits long enough for the provider's TUI to ingest the
// pasted text. Codex's TUI drops an immediate Enter (the prompt sits unsent);
// Claude submits fine with no delay. Verified against the real binaries.
// ---------------------------------------------------------------------------

interface SendTextCall {
  name: string;
  text: string;
  opts?: { submitDelayMs?: number };
}

function makeDeps(provider: string, calls: SendTextCall[]) {
  return {
    fs: {
      // send() reads meta to learn the provider, and computes eventsDir for
      // the stop-mtime snapshot.
      readMeta: async () => ({ name: 's', cwd: '/tmp', provider, jsonlPath: null }),
      eventsDir: () => '/tmp/nonexistent-events',
    },
    tmux: {
      hasSession: async () => true,
      sendText: async (name: string, text: string, opts?: { submitDelayMs?: number }) => {
        calls.push({ name, text, ...(opts !== undefined ? { opts } : {}) });
      },
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
      deps: makeDeps('codex', calls) as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('hello');
    expect(calls[0]?.opts?.submitDelayMs).toBe(CodexProvider.submitDelayMs);
    // Sanity: codex actually declares a positive delay (the whole point).
    expect(CodexProvider.submitDelayMs).toBeGreaterThan(0);
  });

  test('claude session → no submit delay (undefined)', async () => {
    const calls: SendTextCall[] = [];
    await send({
      name: 's',
      prompt: 'hi',
      env: { UMBEL_STATE: '/tmp/x' },
      deps: makeDeps('claude', calls) as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.submitDelayMs).toBeUndefined();
  });
});
