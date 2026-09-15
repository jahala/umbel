import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

// codex can hold a submitted prompt as `[Pasted Content N chars]` in its input
// box and ignore the Enter that should take it (jahala/umbel#77). send must see
// the placeholder still pending and press Enter again, a bounded number of
// times, so the turn starts; a worker that took the first Enter gets no more.

const PROMPT = 'summarise the repository';

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

async function codexWorker(swallowEnters: number) {
  const state = await tmp('umbel-confirm-submit-');
  const userCodex = await tmp('umbel-confirm-submit-codex-home-');
  const cwd = await tmp('umbel-confirm-submit-cwd-');
  await writeFile(join(userCodex, 'auth.json'), '{"OPENAI_API_KEY":"fake"}');
  await writeFile(join(userCodex, 'config.toml'), 'model = "fake-model"\n');
  const stdinLog = join(cwd, 'stdin.log');
  const env = { UMBEL_STATE: state, CODEX_HOME: userCodex };
  const { session } = await spawn({
    cwd,
    provider: 'codex',
    claudeBin: join(import.meta.dir, '../fixtures/fake-codex.sh'),
    env: {
      ...env,
      FAKE_CODEX_JSONL_DIR: cwd,
      FAKE_CODEX_HOOK: join(state, 'hooks', 'stop.sh'),
      FAKE_CODEX_SWALLOW_ENTERS: String(swallowEnters),
      FAKE_CODEX_STDIN_LOG: stdinLog,
    },
  });
  CREATED.push(session.name);
  return { name: session.name, env, stdinLog };
}

async function stdinLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').slice(0, -1);
}

describe('send — confirms the turn started', () => {
  test('a codex that swallows the first Enter still runs its turn', async () => {
    const w = await codexWorker(1);

    const { sinceMtime } = await send({ name: w.name, prompt: PROMPT, env: w.env });
    const result = await waitFor({
      name: w.name,
      sinceMtime,
      env: w.env,
      defaultTimeoutMs: 10_000,
    });

    expect(result.reason).toBe('stop');
    expect(result.stopped).toBe(true);
    expect(await stdinLines(w.stdinLog)).toEqual([PROMPT, '']);
  }, 30_000);

  test('a codex that takes the first Enter gets no extra Enter', async () => {
    const w = await codexWorker(0);

    const { sinceMtime } = await send({ name: w.name, prompt: PROMPT, env: w.env });
    const result = await waitFor({
      name: w.name,
      sinceMtime,
      env: w.env,
      defaultTimeoutMs: 10_000,
    });

    expect(result.reason).toBe('stop');
    expect(await stdinLines(w.stdinLog)).toEqual([PROMPT]);
  }, 30_000);
});
