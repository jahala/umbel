import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import type { Deps } from '../../src/operations/deps.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

// The idle net must measure stillness across every source umbel can see: the
// pane, the session's events directory and the transcript tree (for claude,
// the subagent transcripts beside the session's). A silent pane alone is not
// a wedged worker.

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

async function spawnFake(fakeEnv: Record<string, string>) {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-idle-sources-'));
  projectsDir = join(tmpDir, 'projects');
  const env = { UMBEL_STATE: tmpDir };
  const cwd = '/tmp';
  const jsonl: Deps['jsonl'] = {
    ...jsonlAdapter,
    discoverSessionJsonl: (o) =>
      jsonlAdapter.discoverSessionJsonl({ ...o, projectsRoot: projectsDir }),
  };
  const { session } = await spawn({
    cwd,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      ...fakeEnv,
      FAKE_CLAUDE_JSONL_DIR: join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-')),
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    },
    deps: { jsonl },
  });
  CREATED.push(session.name);
  const { sinceMtime } = await send({ name: session.name, prompt: 'go', env });
  return { name: session.name, env, sinceMtime, deps: { jsonl } };
}

describe('waitFor — idle measured across pane, events and transcript tree', () => {
  test('a silent pane while a subagent transcript grows settles stop, not idle', async () => {
    const w = await spawnFake({ FAKE_CLAUDE_SUBAGENT_MS: '4000' });

    const result = await waitFor({
      name: w.name,
      sinceMtime: w.sinceMtime,
      idleTimeoutMs: 1500,
      env: w.env,
      deps: w.deps,
      defaultTimeoutMs: 15_000,
    });

    expect(result.reason).toBe('stop');
    expect(result.stopped).toBe(true);
  }, 20_000);

  test('a worker whose every source is still settles idle at the threshold', async () => {
    const w = await spawnFake({ FAKE_CLAUDE_HANG_MS: '4000' });

    const startedAt = Date.now();
    const result = await waitFor({
      name: w.name,
      sinceMtime: w.sinceMtime,
      idleTimeoutMs: 1500,
      env: w.env,
      deps: w.deps,
      defaultTimeoutMs: 15_000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.reason).toBe('idle');
    expect(result.stopped).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(3000);
  }, 20_000);

  test('a pane that keeps printing through the turn settles stop', async () => {
    const w = await spawnFake({ FAKE_CLAUDE_PANE_MS: '4000' });

    const result = await waitFor({
      name: w.name,
      sinceMtime: w.sinceMtime,
      idleTimeoutMs: 1500,
      env: w.env,
      deps: w.deps,
      defaultTimeoutMs: 15_000,
    });

    expect(result.reason).toBe('stop');
    expect(result.stopped).toBe(true);
  }, 20_000);
});
