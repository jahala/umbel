import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import { SessionDeadError, WaitTimeoutError } from '../../src/core/errors.ts';
import { runP } from '../../src/faces/p.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
let projectsDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-p-mode-test-'));
  projectsDir = join(tmpDir, 'projects');
  return { RCTRL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
    projectsDir = '';
  }
});

// ---------------------------------------------------------------------------
// Shared opts builder
// ---------------------------------------------------------------------------

function makeOpts(
  env: Record<string, string | undefined>,
  cwd: string,
  extra: Partial<Parameters<typeof runP>[0]> = {},
): Parameters<typeof runP>[0] {
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const jsonlDir = join(projectsDir, encodedCwd);
  return {
    prompt: 'hello',
    cwd,
    outputFormat: 'text',
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    },
    deps: {
      jsonl: {
        ...jsonlAdapter,
        discoverSessionJsonl: (opts) =>
          jsonlAdapter.discoverSessionJsonl({ ...opts, projectsRoot: projectsDir }),
      },
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('p-mode', () => {
  test('one-shot anonymous: returns response and kills session', async () => {
    const env = await setup();
    const opts = makeOpts(env, tmpDir, { prompt: 'hi' });

    const result = await runP(opts);

    expect(result.text).toContain('Response to: hi');
    expect(result.sessionName).toBeTruthy();
    // Anonymous session should be dead after runP returns
    // (we check tmux — it should be gone)
    const { hasSession } = await import('../../src/adapters/tmux.ts');
    const alive = await hasSession(result.sessionName);
    expect(alive).toBe(false);
  });

  test('--name foo persists session after runP', async () => {
    const env = await setup();
    const name = sessionName('np');
    CREATED.push(name);

    const opts = makeOpts(env, tmpDir, { prompt: 'hello', name });
    const result = await runP(opts);

    expect(result.text).toContain('Response to: hello');
    expect(result.sessionName).toBe(name);

    const { hasSession } = await import('../../src/adapters/tmux.ts');
    const alive = await hasSession(name);
    expect(alive).toBe(true);
  });

  // Lines 65-66: named session reuse path — second call with same name reuses existing
  test('--name foo second call reuses existing session (no second spawn)', async () => {
    const env = await setup();
    const name = sessionName('reuse');
    CREATED.push(name);

    // First call: creates the named session
    const opts1 = makeOpts(env, tmpDir, { prompt: 'first', name });
    const result1 = await runP(opts1);
    expect(result1.sessionName).toBe(name);

    // Second call: session already exists — should reuse, not spawn again
    const opts2 = makeOpts(env, tmpDir, { prompt: 'second', name });
    const result2 = await runP(opts2);
    expect(result2.sessionName).toBe(name);
    expect(result2.text).toContain('Response to: second');

    // Verify only one tmux session exists with this name
    const { listSessions } = await import('../../src/adapters/tmux.ts');
    const sessions = await listSessions();
    const matching = sessions.filter((s) => s === name);
    expect(matching.length).toBe(1);
  });

  test('--resume reuses existing session', async () => {
    const env = await setup();
    const name = sessionName('rs');
    CREATED.push(name);

    // First call creates named session
    const opts1 = makeOpts(env, tmpDir, { prompt: 'first', name });
    await runP(opts1);

    // Second call resumes it
    const opts2 = makeOpts(env, tmpDir, { prompt: 'second', resume: name });
    const result2 = await runP(opts2);

    expect(result2.text).toContain('Response to: second');
    expect(result2.sessionName).toBe(name);
  });

  test('multi-line prompt works', async () => {
    const env = await setup();
    const opts = makeOpts(env, tmpDir, { prompt: 'line1\nline2\nline3' });

    const result = await runP(opts);
    // fake-claude reads multi-line input line-by-line, producing N turns for
    // N lines. wait returns on the first Stop hook fire. Verify the transcript
    // file contains turn 1's response — that's deterministic. (parseTranscript
    // reading "Thinking..." from a started-but-incomplete turn 2 in result.text
    // is a fake-claude artifact, not a production issue: real claude treats
    // bracketed-paste multi-line as a single turn.)
    const jsonl = await Bun.file(result.jsonlPath).text();
    expect(jsonl).toContain('Response to: line1');
  });

  test('outputFormat json returns parseable JSON', async () => {
    const env = await setup();
    const opts = makeOpts(env, tmpDir, { prompt: 'hi', outputFormat: 'json' });

    const result = await runP(opts);
    // runP returns PModeResult regardless of outputFormat — the format is for CLI output
    // The result.text should still be the text content
    expect(result.text).toContain('Response to: hi');
    expect(result.sessionName).toBeTruthy();
  });

  test('timeout throws WaitTimeoutError', async () => {
    const env = await setup();
    const opts = makeOpts(env, tmpDir, {
      prompt: 'slow',
      timeoutMs: 50, // Very short — fake-claude with no delay won't cause timeout normally
      // Force slow response
      env: {
        ...env,
        FAKE_CLAUDE_JSONL_DIR: join(projectsDir, tmpDir.replace(/[^a-zA-Z0-9]/g, '-')),
        FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
        FAKE_CLAUDE_DELAY: '500', // 500ms delay, timeout is 50ms
      },
    });

    await expect(runP(opts)).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  test('worker that dies mid-turn throws SessionDeadError', async () => {
    const env = await setup();
    // Stays alive past the prompt send, then exits non-zero without ever firing
    // the stop hook. waitFor must detect the vanished session and runP must
    // surface it as SessionDeadError — not hang until the (generous) timeout.
    const dyingClaude = join(tmpDir, 'dying-claude.sh');
    await writeFile(dyingClaude, '#!/usr/bin/env bash\nsleep 3\nexit 1\n', { mode: 0o755 });

    const opts = makeOpts(env, tmpDir, {
      prompt: 'will crash',
      claudeBin: dyingClaude,
      timeoutMs: 30_000,
    });

    await expect(runP(opts)).rejects.toBeInstanceOf(SessionDeadError);
  }, 15_000);

  test('AbortSignal cancels wait and throws AbortError', async () => {
    const env = await setup();
    const ac = new AbortController();
    const opts = makeOpts(env, tmpDir, {
      prompt: 'slow',
      signal: ac.signal,
      env: {
        ...env,
        FAKE_CLAUDE_JSONL_DIR: join(projectsDir, tmpDir.replace(/[^a-zA-Z0-9]/g, '-')),
        FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
        FAKE_CLAUDE_DELAY: '2000', // 2s delay
      },
    });

    // Abort after a short delay
    setTimeout(() => ac.abort(), 100);

    await expect(runP(opts)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
