import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-codex-test-'));
  return { RCTRL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  // Must pass SessionNameSchema: lowercase, starts with letter/digit
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
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
// hooks.json written at spawn time
// ---------------------------------------------------------------------------

describe('codex-provider — hooks.json lifecycle', () => {
  test('spawn writes <cwd>/.codex/hooks.json before launch', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd));
      CREATED.push(session.name);

      const hooksPath = join(cwd, '.codex', 'hooks.json');
      expect(existsSync(hooksPath)).toBe(true);
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

      const hooksPath = join(cwd, '.codex', 'hooks.json');
      const raw = await readFile(hooksPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      // The command in the Stop hook must be our stop.sh path
      const stopSh = join(tmpDir, 'hooks', 'stop.sh');
      expect(raw).toContain(stopSh);
      expect(parsed).toMatchObject({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: stopSh }] }] },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end turn: send → stop fires → transcript readable
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
// kill removes hooks.json (providerFiles cleanup)
// ---------------------------------------------------------------------------

describe('codex-provider — kill cleans up hooks.json', () => {
  test('kill removes <cwd>/.codex/hooks.json written at spawn', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    const name = sessionName('kill');
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd, { name }));
      // Do NOT push to CREATED — kill under test handles cleanup

      const hooksPath = join(cwd, '.codex', 'hooks.json');
      expect(existsSync(hooksPath)).toBe(true);

      await kill({ name: session.name, env });

      expect(existsSync(hooksPath)).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('kill with removeState=false leaves hooks.json in place', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    const name = sessionName('killnorm');
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd, { name }));
      CREATED.push(session.name);

      const hooksPath = join(cwd, '.codex', 'hooks.json');
      expect(existsSync(hooksPath)).toBe(true);

      // removeState=false skips providerFiles cleanup
      await kill({ name: session.name, removeState: false, env });

      expect(existsSync(hooksPath)).toBe(true);

      // Manual cleanup to avoid leaking state dir
      await rm(join(tmpDir, 'sessions', session.name), { recursive: true, force: true });
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

  test('meta.json providerFiles contains absolute path to hooks.json', async () => {
    const env = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'rctrl-codex-cwd-'));
    try {
      const { session } = await spawn(makeSpawnOpts(env, cwd));
      CREATED.push(session.name);
      const expectedPath = join(cwd, '.codex', 'hooks.json');
      expect(session.providerFiles).toContain(expectedPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
