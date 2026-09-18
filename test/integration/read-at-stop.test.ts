import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import {
  resolveTranscriptContent,
  TURN_END_SETTLE_MS,
} from '../../src/operations/resolve-transcript.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

// ---------------------------------------------------------------------------
// umbel#86: a stop means the worker's final message is readable in full.
//
// Real claude fires the Stop hook before it writes the turn's final message.
// Measured against the installed binary, the final text was missing when the
// hook fired in 12 of 13 turns, and in the six turns timed it landed 200-400ms
// later. A read taken at the stop sees the message before the last one.
// FAKE_CLAUDE_LATE_FINAL_MS reproduces that order.
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
const LATE_MS = 700;
const PROMPT = 'close the loop';
const FINAL = `Response to: ${PROMPT}`;

let tmpDir = '';
let projectsDir = '';
const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
    projectsDir = '';
  }
});

async function lateWorker(
  suffix: string,
  lateMs = LATE_MS,
): Promise<{ name: string; env: Record<string, string> }> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-read-at-stop-'));
  projectsDir = join(tmpDir, 'projects');
  const env = { UMBEL_STATE: tmpDir };
  const name = `t${RUN_ID}${suffix}`;
  await spawn({
    name,
    cwd: '/tmp',
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      FAKE_CLAUDE_JSONL_DIR: join(projectsDir, '-tmp'),
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
      FAKE_CLAUDE_LATE_FINAL_MS: String(lateMs),
    },
    deps: {
      jsonl: {
        ...jsonlAdapter,
        discoverSessionJsonl: (o) =>
          jsonlAdapter.discoverSessionJsonl({ ...o, projectsRoot: projectsDir }),
      },
    },
  });
  CREATED.push(name);
  return { name, env };
}

function eventsFile(name: string, file: string): string {
  return join(tmpDir, 'sessions', name, 'events', file);
}

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

describe('read at stop (umbel#86)', () => {
  test('wait reports stop only once the final message is on disk', async () => {
    const { name, env } = await lateWorker('w');
    const { sinceMtime } = await send({ name, prompt: PROMPT, env });

    const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 15_000 });
    expect(result.reason).toBe('stop');

    // A plain read, with no waiting of its own: what a conductor that trusts
    // the stop would see.
    const path = (await readFile(eventsFile(name, 'transcript-path'), 'utf8')).trim();
    expect(ClaudeProvider.parseTranscript(await readFile(path, 'utf8'))).toBe(FINAL);
  }, 30_000);

  test('wait says so when the final message has not landed by the end of the window', async () => {
    // Lands long after the settle window, so the wait must give up and report
    // the stop with a warning instead of holding past the window.
    const { name, env } = await lateWorker('g', TURN_END_SETTLE_MS * 4);
    const { sinceMtime } = await send({ name, prompt: PROMPT, env });

    const started = Date.now();
    const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 60_000 });
    const held = Date.now() - started;

    expect(result.reason).toBe('stop');
    expect(result.message).toMatch(/final message was not in the transcript/);
    expect(held).toBeLessThan(TURN_END_SETTLE_MS + 2_000);
  }, 60_000);

  test('read taken the moment the stop lands returns the final message', async () => {
    const { name, env } = await lateWorker('r');
    const stopFile = eventsFile(name, 'stop');
    const before = await mtimeOf(stopFile);
    await send({ name, prompt: PROMPT, env });

    // Watch the stop the way a conductor with its own loop does, then read at
    // once, without umbel's wait.
    const deadline = Date.now() + 15_000;
    while ((await mtimeOf(stopFile)) <= before && Date.now() < deadline) await Bun.sleep(20);

    const content = await resolveTranscriptContent({
      name,
      cwd: '/tmp',
      sinceMs: 0,
      provider: ClaudeProvider,
      env,
      deps: {
        jsonl: {
          ...jsonlAdapter,
          discoverSessionJsonl: (o) =>
            jsonlAdapter.discoverSessionJsonl({ ...o, projectsRoot: projectsDir }),
        },
      },
    });
    expect(ClaudeProvider.parseTranscript(content)).toBe(FINAL);
  }, 30_000);
});
