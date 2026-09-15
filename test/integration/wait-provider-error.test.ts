import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

// A provider error on the pane followed by stillness is a failed turn, not a
// quiet one: wait settles provider-error with the error line long before the
// idle threshold. An error line followed by more output is a retry in progress
// and must not settle.

const IDLE_MS = 60_000;
// Grace is max(two polls, 3 s); with a 60 s threshold a poll is 2 s, so a still
// error settles within a poll or two of the grace. Far below IDLE_MS either way.
const SETTLE_WITHIN_MS = 10_000;

const CODEX_404 =
  'unexpected status 404 Not Found: The model gpt-5.5 does not exist or you do not have access to it';
const CODEX_NO_ACCESS = 'The model gpt-5.5 does not exist or you do not have access to it.';
const CLAUDE_529 = 'API Error: 529 overloaded';

const DIRS: string[] = [];
const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  await Promise.all(DIRS.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  DIRS.push(dir);
  return dir;
}

async function codexWorker(fakeEnv: Record<string, string>) {
  const state = await tmp('umbel-provider-error-codex-');
  const userCodex = await tmp('umbel-provider-error-codex-home-');
  const cwd = await tmp('umbel-provider-error-codex-cwd-');
  await writeFile(join(userCodex, 'auth.json'), '{"OPENAI_API_KEY":"fake"}');
  await writeFile(join(userCodex, 'config.toml'), 'model = "fake-model"\n');
  const env = { UMBEL_STATE: state, CODEX_HOME: userCodex };
  const { session } = await spawn({
    cwd,
    provider: 'codex',
    claudeBin: join(import.meta.dir, '../fixtures/fake-codex.sh'),
    env: {
      ...env,
      FAKE_CODEX_JSONL_DIR: cwd,
      FAKE_CODEX_HOOK: join(state, 'hooks', 'stop.sh'),
      ...fakeEnv,
    },
  });
  CREATED.push(session.name);
  const { sinceMtime } = await send({ name: session.name, prompt: 'go', env });
  return { name: session.name, env, sinceMtime };
}

async function claudeWorker(fakeEnv: Record<string, string>) {
  const state = await tmp('umbel-provider-error-claude-');
  const env = { UMBEL_STATE: state };
  const { session } = await spawn({
    cwd: state,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      FAKE_CLAUDE_JSONL_DIR: join(state, 'projects'),
      FAKE_CLAUDE_HOOK: join(state, 'hooks', 'stop.sh'),
      ...fakeEnv,
    },
  });
  CREATED.push(session.name);
  const { sinceMtime } = await send({ name: session.name, prompt: 'go', env });
  return { name: session.name, env, sinceMtime };
}

// tmux wraps a line wider than the pane, so the matched row may be a fragment of
// what the provider printed. It must still be a trimmed piece of that line.
function expectErrorLine(message: string | undefined, printed: string, marker: RegExp): void {
  expect(message).toBeDefined();
  const m = message ?? '';
  expect(m).toMatch(marker);
  expect(m).toBe(m.trim());
  expect(printed).toContain(m);
}

async function timedWait(w: { name: string; env: Record<string, string>; sinceMtime: number }) {
  const startedAt = Date.now();
  const result = await waitFor({
    name: w.name,
    sinceMtime: w.sinceMtime,
    idleTimeoutMs: IDLE_MS,
    env: w.env,
    defaultTimeoutMs: 20_000,
  });
  return { result, elapsedMs: Date.now() - startedAt };
}

describe('waitFor — a provider error followed by stillness settles provider-error', () => {
  test('codex 404 at its prompt settles provider-error with the line, well before idle', async () => {
    const w = await codexWorker({ FAKE_CODEX_ERROR: CODEX_404 });

    const { result, elapsedMs } = await timedWait(w);

    expect(result.reason).toBe('provider-error');
    expect(result.stopped).toBe(false);
    expect(elapsedMs).toBeLessThan(SETTLE_WITHIN_MS);
    expectErrorLine(result.message, CODEX_404, /unexpected status 404/i);
    expect(result.paneSnapshot?.replace(/\s+/g, '')).toContain(CODEX_404.replace(/\s+/g, ''));
  }, 30_000);

  test('codex model-access error without a status code also settles provider-error', async () => {
    const w = await codexWorker({ FAKE_CODEX_ERROR: CODEX_NO_ACCESS });

    const { result, elapsedMs } = await timedWait(w);

    expect(result.reason).toBe('provider-error');
    expect(elapsedMs).toBeLessThan(SETTLE_WITHIN_MS);
    expectErrorLine(result.message, CODEX_NO_ACCESS, /do not have access|does not exist/i);
  }, 30_000);

  test('claude API Error then a still pane settles provider-error', async () => {
    const w = await claudeWorker({ FAKE_CLAUDE_ERROR: CLAUDE_529, FAKE_CLAUDE_HANG_MS: '25000' });

    const { result, elapsedMs } = await timedWait(w);

    expect(result.reason).toBe('provider-error');
    expect(elapsedMs).toBeLessThan(SETTLE_WITHIN_MS);
    expect(result.message).toBe(CLAUDE_529);
    expect(result.paneSnapshot).toContain(CLAUDE_529);
  }, 30_000);
});

describe('waitFor — an error line followed by further progress does not settle', () => {
  test('codex error then a completed turn settles stop', async () => {
    const w = await codexWorker({
      FAKE_CODEX_ERROR: CODEX_404,
      FAKE_CODEX_ERROR_THEN_CONTINUE: '1',
    });

    const { result } = await timedWait(w);

    expect(result.reason).toBe('stop');
    expect(result.stopped).toBe(true);
  }, 30_000);

  test('claude API Error followed by pane output past the grace settles stop', async () => {
    // Progress lines keep arriving for 6 s, longer than any grace, while the
    // error line stays within the pane's last lines.
    const w = await claudeWorker({ FAKE_CLAUDE_ERROR: CLAUDE_529, FAKE_CLAUDE_PANE_MS: '6000' });

    const { result } = await timedWait(w);

    expect(result.reason).toBe('stop');
    expect(result.stopped).toBe(true);
  }, 30_000);
});
