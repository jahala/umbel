import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';
import { resolveTranscriptContent } from '../../src/operations/resolve-transcript.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';
import { waitFor } from '../../src/operations/wait.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-opencode-test-'));
  // Isolate the opencode config dir so installGlobalPlugin never touches ~/.config.
  return { UMBEL_STATE: tmpDir, XDG_CONFIG_HOME: join(tmpDir, 'xdg') };
}

function sessionName(suffix: string): string {
  // Must pass SessionNameSchema: lowercase, starts with letter/digit
  return `o${RUN_ID}${suffix}`;
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
// Fixture mechanics check — independent of provider registry.
// Verifies that fake-opencode.sh itself creates events/stop + events/session-id
// when run with UMBEL_STATE / UMBEL_SESSION_ID set. These PASS regardless of
// whether the opencode provider is registered — they test the fixture directly.
// ---------------------------------------------------------------------------

const FAKE_OPENCODE = join(import.meta.dir, '../fixtures/fake-opencode.sh');

describe('fake-opencode.sh — fixture mechanics (must PASS)', () => {
  test('creates events/stop and events/session-id when given a prompt via stdin', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'umbel-oc-fixture-'));
    try {
      const sessionId = 'fixture-test-session';
      const eventsDir = join(stateDir, 'sessions', sessionId, 'events');
      await mkdir(eventsDir, { recursive: true });

      const proc = Bun.spawn([FAKE_OPENCODE], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          UMBEL_STATE: stateDir,
          UMBEL_SESSION_ID: sessionId,
        },
      });

      // Send one prompt line then EOF to let the fake process it and exit.
      proc.stdin.write('hello opencode\n');
      proc.stdin.end();
      await proc.exited;

      const stopPath = join(eventsDir, 'stop');
      const sessionIdPath = join(eventsDir, 'session-id');

      const stopStat = await stat(stopPath);
      expect(stopStat.isFile()).toBe(true);

      const sidStat = await stat(sessionIdPath);
      expect(sidStat.isFile()).toBe(true);

      const sid = (await Bun.file(sessionIdPath).text()).trim();
      expect(sid.length).toBeGreaterThan(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('events/session-id contains the fake session ID ses_fake123', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'umbel-oc-fixture2-'));
    try {
      const sessionId = 'fixture-sid-check';
      const eventsDir = join(stateDir, 'sessions', sessionId, 'events');
      await mkdir(eventsDir, { recursive: true });

      const proc = Bun.spawn([FAKE_OPENCODE], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          UMBEL_STATE: stateDir,
          UMBEL_SESSION_ID: sessionId,
        },
      });

      proc.stdin.write('what is 2+2\n');
      proc.stdin.end();
      await proc.exited;

      const sessionIdPath = join(eventsDir, 'session-id');
      const sid = (await Bun.file(sessionIdPath).text()).trim();
      expect(sid).toBe('ses_fake123');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Provider integration tests — RED because 'opencode' is not yet in
// ProviderNameSchema or the registry. These fail at spawn time with a
// validation / ProviderUnknownError about 'opencode' being an unknown provider.
// ---------------------------------------------------------------------------

// Minimal sample opencode-export JSON matching the real shape from §4 of
// docs/research/opencode-surface.md. The assistant text is OPENCODE_OK.
const SAMPLE_EXPORT_JSON = JSON.stringify({
  info: {
    id: 'ses_fake123',
    slug: 'test-session',
    projectID: 'global',
    directory: '/tmp',
    title: 'Test session',
    model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' },
    version: '1.15.12',
  },
  messages: [
    {
      info: { role: 'user' },
      parts: [{ type: 'text', text: 'hello' }],
    },
    {
      info: { role: 'assistant', finish: 'stop' },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'OPENCODE_OK', time: { start: 0, end: 1 } },
        { type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 3 }, cost: 0 },
      ],
    },
  ],
});

function makeSpawnOpts(
  env: Record<string, string | undefined>,
  cwd: string,
  extra?: Partial<Parameters<typeof spawn>[0]>,
): Parameters<typeof spawn>[0] {
  return {
    cwd,
    provider: 'opencode',
    claudeBin: FAKE_OPENCODE,
    env: {
      ...env,
    },
    ...extra,
  };
}

describe('opencode provider — spawn', () => {
  test('spawn --provider opencode resolves and session.provider is opencode', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('spawn');
    CREATED.push(name);

    const { session } = await spawn(makeSpawnOpts(env, cwd, { name }));
    expect(session.provider).toBe('opencode');
  });
});

describe('opencode provider — send+wait', () => {
  test('send prompt → wait → stop file fires (requires provider to be registered)', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('sw');
    CREATED.push(name);

    // Now that the provider is registered, this exercises the full turn loop.
    const { session } = await spawn(makeSpawnOpts(env, cwd, { name }));
    expect(session.provider).toBe('opencode');

    const { sinceMtime } = await send({ name, prompt: 'hello opencode', env });

    const result = await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 15_000 });
    expect(result.stopped).toBe(true);
    expect(result.reason).toBe('stop');

    const stopPath = join(tmpDir, 'sessions', name, 'events', 'stop');
    const s = await stat(stopPath);
    expect(s.isFile()).toBe(true);
  });
});

describe('opencode provider — read via exportTranscript', () => {
  test('resolveTranscriptContent runs opencode export and returns assistant text', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('read');
    CREATED.push(name);

    // Now that the provider is registered, this exercises the full read path:
    // events/session-id → exec.run → opencode export → parse → OPENCODE_OK.
    const { session } = await spawn(makeSpawnOpts(env, cwd, { name }));
    expect(session.provider).toBe('opencode');

    const { sinceMtime } = await send({ name, prompt: 'hello', env });
    await waitFor({ name, sinceMtime, env, defaultTimeoutMs: 15_000 });

    // Fake exec: for any argv starting with 'opencode export', return sample JSON.
    const fakeExec = {
      run: async (argv: readonly string[]) => {
        if (argv[0] === 'opencode' && argv[1] === 'export') {
          return SAMPLE_EXPORT_JSON;
        }
        throw new Error(`unexpected argv: ${argv.join(' ')}`);
      },
    };

    // Import provider dynamically so the test file parses even before the
    // provider module exists (avoids a static import error at parse time).
    const { OpenCodeProvider } = await import('../../src/core/providers/opencode.ts');

    const content = await resolveTranscriptContent({
      name,
      cwd,
      sinceMs: session.createdAt,
      provider: OpenCodeProvider,
      env,
      deps: { exec: fakeExec },
    });

    // OpenCodeProvider.parseTranscript must extract "OPENCODE_OK" from the
    // sample export JSON.
    const text = OpenCodeProvider.parseTranscript(content);
    expect(text).toBe('OPENCODE_OK');
  });
});
