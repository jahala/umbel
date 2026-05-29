import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import * as tmuxAdapter from '../../src/adapters/tmux.ts';
import { spawn } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// Worker env passthrough (TDD red)
//
// rctrl currently strips the worker's environment to a 7-var allowlist
// (SAFE_INHERITED in src/operations/spawn.ts), so a user's exported env vars
// (proxies, API keys, custom config dirs) silently never reach the worker.
// These tests pin the intended behaviour: inherit the environment by default,
// MINUS the shell-init vars that break tmux send-keys, plus an explicit
// per-worker override channel.
//
// We inject a fake tmux whose newSession captures the env that WOULD be handed
// to the session and assert on it — no real tmux session is created.
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
let projectsDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-spawnenv-test-'));
  projectsDir = join(tmpDir, 'projects');
  return { RCTRL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  return `t${RUN_ID}${suffix}`;
}

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
    projectsDir = '';
  }
});

function makeOpts(
  env: Record<string, string | undefined>,
  cwd: string,
  extra?: Partial<Parameters<typeof spawn>[0]>,
): Parameters<typeof spawn>[0] {
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const jsonlDir = join(projectsDir, encodedCwd);
  return {
    cwd,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    },
    deps: {
      jsonl: {
        ...jsonlAdapter,
        discoverSessionJsonl: (o) =>
          jsonlAdapter.discoverSessionJsonl({ ...o, projectsRoot: projectsDir }),
      },
    },
    ...extra,
  };
}

// Inject a fake tmux that captures the env handed to newSession (no real spawn).
async function captureWorkerEnv(
  opts: Parameters<typeof spawn>[0],
): Promise<Record<string, string>> {
  let captured: Record<string, string> = {};
  const fakeTmux = {
    ...tmuxAdapter,
    newSession: async (o: { env: Record<string, string> }) => {
      captured = o.env;
    },
  };
  await spawn({ ...opts, deps: { ...opts.deps, tmux: fakeTmux as never } });
  return captured;
}

describe('spawn — worker env passthrough', () => {
  // Guard: the two vars the common case relies on must keep flowing.
  test('PATH and HOME still reach the worker', async () => {
    const env = await setup();
    const captured = await captureWorkerEnv(makeOpts(env, '/tmp', { name: sessionName('base') }));
    expect(captured.PATH).toBeDefined();
    expect(captured.HOME).toBeDefined();
  });

  // RED: arbitrary exported vars are stripped by the 7-var allowlist today.
  test('inherits an arbitrary exported env var into the worker', async () => {
    const env = await setup();
    const KEY = 'RCTRL_ENVTEST_PASSTHRU';
    process.env[KEY] = 'inherited-value';
    try {
      const captured = await captureWorkerEnv(makeOpts(env, '/tmp', { name: sessionName('inh') }));
      expect(captured[KEY]).toBe('inherited-value');
    } finally {
      delete process.env[KEY];
    }
  });

  // RED: no per-worker override channel exists yet.
  test('forwards an explicit per-worker env override', async () => {
    const env = await setup();
    // `workerEnv` is implemented in the follow-up (allowlist→denylist) task;
    // the cast documents the forthcoming SpawnOpts field. RED until then.
    const opts = {
      ...makeOpts(env, '/tmp', { name: sessionName('over') }),
      workerEnv: { RCTRL_ENVTEST_OVERRIDE: 'explicit-value' },
    } as Parameters<typeof spawn>[0];
    const captured = await captureWorkerEnv(opts);
    expect(captured.RCTRL_ENVTEST_OVERRIDE).toBe('explicit-value');
  });

  // Guard: the vars that break tmux send-keys must NEVER reach the worker,
  // even once we switch to inherit-by-default.
  test('does NOT leak tmux-breaking shell-init vars (regression guard)', async () => {
    const env = await setup();
    process.env.PROMPT_COMMAND = 'echo SHOULD_NOT_LEAK';
    process.env.BASH_ENV = '/tmp/should-not-leak.sh';
    try {
      const captured = await captureWorkerEnv(
        makeOpts(env, '/tmp', { name: sessionName('guard') }),
      );
      expect(captured.PROMPT_COMMAND).toBeUndefined();
      expect(captured.BASH_ENV).toBeUndefined();
      expect(captured.SHELL).toBeUndefined();
    } finally {
      delete process.env.PROMPT_COMMAND;
      delete process.env.BASH_ENV;
    }
  });
});
