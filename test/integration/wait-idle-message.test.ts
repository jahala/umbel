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

// An idle result must say what stayed still and for how long, so a conductor
// can judge a wedged worker without watching its pane. Every source is named;
// one umbel could not resolve reads as unresolved instead of vanishing.

const IDLE_MS = 1500;

let tmpDir = '';
const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

function stillSeconds(message: string, source: string): number {
  const match = new RegExp(`\\b${source} still (\\d+(?:\\.\\d+)?)s\\b`).exec(message);
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

async function hungClaude() {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-idle-message-'));
  const projectsDir = join(tmpDir, 'projects');
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
      FAKE_CLAUDE_HANG_MS: '6000',
      FAKE_CLAUDE_JSONL_DIR: join(projectsDir, jsonlAdapter.encodeCwd(cwd)),
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    },
    deps: { jsonl },
  });
  CREATED.push(session.name);
  const { sinceMtime } = await send({ name: session.name, prompt: 'go', env });
  return { name: session.name, env, sinceMtime, deps: { jsonl } };
}

async function silentOpencode() {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-idle-message-oc-'));
  // Isolate the opencode config dir so the global plugin never touches ~/.config.
  const env = { UMBEL_STATE: tmpDir, XDG_CONFIG_HOME: join(tmpDir, 'xdg') };
  const { session } = await spawn({
    cwd: tmpDir,
    provider: 'opencode',
    claudeBin: join(import.meta.dir, '../fixtures/fake-opencode.sh'),
    env: { ...env, FAKE_OPENCODE_DELAY: '6000' },
  });
  CREATED.push(session.name);
  const { sinceMtime } = await send({ name: session.name, prompt: 'go', env });
  return { name: session.name, env, sinceMtime };
}

describe('waitFor — idle message names every source and its stillness', () => {
  test('a hung claude worker names pane, events, transcript and subagents with numbers', async () => {
    const w = await hungClaude();

    const result = await waitFor({
      name: w.name,
      sinceMtime: w.sinceMtime,
      idleTimeoutMs: IDLE_MS,
      env: w.env,
      deps: w.deps,
      defaultTimeoutMs: 15_000,
    });

    expect(result.reason).toBe('idle');
    const message = result.message ?? '';
    expect(message).toMatch(/^idle \d+(?:\.\d+)?s: /);
    for (const source of ['pane', 'events', 'transcript']) {
      expect(stillSeconds(message, source)).toBeGreaterThanOrEqual(IDLE_MS / 1000);
    }
    expect(message).toMatch(/\bsubagents (none|still \d+(?:\.\d+)?s)\b/);
    expect(message).not.toContain('unresolved');
  }, 20_000);

  test('an opencode worker, which has no transcript file, reads transcript unresolved', async () => {
    const w = await silentOpencode();

    const result = await waitFor({
      name: w.name,
      sinceMtime: w.sinceMtime,
      idleTimeoutMs: IDLE_MS,
      env: w.env,
      defaultTimeoutMs: 15_000,
    });

    expect(result.reason).toBe('idle');
    const message = result.message ?? '';
    expect(stillSeconds(message, 'pane')).toBeGreaterThanOrEqual(IDLE_MS / 1000);
    expect(stillSeconds(message, 'events')).toBeGreaterThanOrEqual(IDLE_MS / 1000);
    expect(message).toMatch(/\btranscript unresolved\b/);
  }, 20_000);
});
