import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { kill } from '../../src/operations/kill.ts';
import { resolveJsonlPath } from '../../src/operations/resolve-jsonl.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

// ---------------------------------------------------------------------------
// Test isolation
//
// codex delivers hooks via a global $CODEX_HOME/hooks.json — a project
// .codex/hooks.json is silently ignored inside linked git worktrees. rctrl
// points the worker at <stateDir>/codex-home and populates it from the user's
// real CODEX_HOME (auth.json symlink + config.toml copy). Both the state dir and
// a fake "user" CODEX_HOME are temp dirs, so nothing touches the real ~/.codex.
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';
let fakeUserCodex = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-codex-test-'));
  fakeUserCodex = await mkdtemp(join(tmpdir(), 'rctrl-codex-userhome-'));
  await writeFile(join(fakeUserCodex, 'auth.json'), '{"OPENAI_API_KEY":"fake"}');
  await writeFile(join(fakeUserCodex, 'config.toml'), 'model = "fake-model"\n');
  return { RCTRL_STATE: tmpDir, CODEX_HOME: fakeUserCodex };
}

function codexHome(): string {
  return join(tmpDir, 'codex-home');
}

function sessionName(suffix: string): string {
  // Must pass SessionNameSchema: lowercase, starts with letter/digit
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  for (const dir of [tmpDir, fakeUserCodex]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  tmpDir = '';
  fakeUserCodex = '';
});

// ---------------------------------------------------------------------------
// Shared spawn helper
// ---------------------------------------------------------------------------

function makeSpawnOpts(
  env: Record<string, string | undefined>,
  cwd: string,
  extra?: Partial<Parameters<typeof spawn>[0]>,
): Parameters<typeof spawn>[0] {
  const hookPath = join(tmpDir, 'hooks', 'stop.sh');
  return {
    cwd,
    provider: 'codex',
    claudeBin: join(import.meta.dir, '../fixtures/fake-codex.sh'),
    env: {
      ...env,
      // fake-codex.sh writes its JSONL here instead of $CODEX_HOME/sessions/...
      FAKE_CODEX_JSONL_DIR: cwd,
      // fake-codex.sh fires this script when a turn completes
      FAKE_CODEX_HOOK: hookPath,
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// CODEX_HOME hook delivery (written at spawn time, isolated from user cwd)
// ---------------------------------------------------------------------------

describe('codex-provider — CODEX_HOME hook delivery', () => {
  test('spawn writes hooks.json into the codex-home, never the worker cwd', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd));
      CREATED.push(session.name);

      expect(existsSync(join(codexHome(), 'hooks.json'))).toBe(true);
      expect(existsSync(join(cwd, '.codex', 'hooks.json'))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('hooks.json content references rctrl stop.sh', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd));
      CREATED.push(session.name);

      const raw = await readFile(join(codexHome(), 'hooks.json'), 'utf8');
      const stopSh = join(tmpDir, 'hooks', 'stop.sh');
      expect(raw).toContain(stopSh);
      expect(JSON.parse(raw)).toMatchObject({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: stopSh }] }] },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('auth.json is symlinked from the user CODEX_HOME (no secret copy)', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd));
      CREATED.push(session.name);

      const authLink = join(codexHome(), 'auth.json');
      expect((await lstat(authLink)).isSymbolicLink()).toBe(true);
      expect(await readlink(authLink)).toBe(join(fakeUserCodex, 'auth.json'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('config.toml is copied from the user CODEX_HOME (carries model/endpoint)', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd));
      CREATED.push(session.name);

      const copied = await readFile(join(codexHome(), 'config.toml'), 'utf8');
      expect(copied).toContain('fake-model');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end turn: send → stop fires → transcript readable
// (fake-codex.sh fires the hook directly, so this is agnostic to CODEX_HOME)
// ---------------------------------------------------------------------------

describe('codex-provider — end-to-end turn', () => {
  test('send prompt → Stop hook fires → resolveJsonlPath returns transcript', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    const name = sessionName('e2e');
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd, { name }));
      CREATED.push(session.name);

      const { sinceMtime } = await send({ name, prompt: 'hello codex', env });

      const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 15_000 });
      expect(result.stopped).toBe(true);
      expect(result.reason).toBe('stop');

      const jsonlPath = await resolveJsonlPath({ name, cwd, sinceMs: session.createdAt, env });
      expect(jsonlPath.length).toBeGreaterThan(0);
      expect(existsSync(jsonlPath)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('CodexProvider.parseTranscript returns agent_message text from real transcript', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    const name = sessionName('parse');
    const prompt = 'parse me please';
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd, { name }));
      CREATED.push(session.name);

      const { sinceMtime } = await send({ name, prompt, env });
      const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 15_000 });
      expect(result.stopped).toBe(true);

      const jsonlPath = await resolveJsonlPath({ name, cwd, sinceMs: session.createdAt, env });
      const content = await readFile(jsonlPath, 'utf8');

      const parsed = CodexProvider.parseTranscript(content);
      // fake-codex.sh responds with "Response to: <prompt>"
      expect(parsed).toContain(`Response to: ${prompt}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The codex-home is SHARED infra: not per-session, survives kill
// ---------------------------------------------------------------------------

describe('codex-provider — shared codex-home lifecycle', () => {
  test('meta.providerFiles excludes the shared codex-home files', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd));
      CREATED.push(session.name);
      // codex's hooks/auth/config are shared across workers — never tracked.
      expect(session.providerFiles).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('kill leaves the shared codex-home in place (other workers depend on it)', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    const name = sessionName('kill');
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd, { name }));
      // Do NOT push to CREATED — kill under test handles the session.
      const hooksPath = join(codexHome(), 'hooks.json');
      expect(existsSync(hooksPath)).toBe(true);

      await kill({ name: session.name, env });

      // The session dir is gone, but the shared codex-home survives.
      expect(existsSync(join(tmpDir, 'sessions', session.name))).toBe(false);
      expect(existsSync(hooksPath)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// provider=codex is recorded in meta.json
// ---------------------------------------------------------------------------

describe('codex-provider — session meta', () => {
  test('meta.json records provider as codex', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd));
      CREATED.push(session.name);
      expect(session.provider).toBe('codex');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('meta.json records model when supplied', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd, { model: 'o4-mini' }));
      CREATED.push(session.name);
      expect(session.model).toBe('o4-mini');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
