import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendText } from '../../src/adapters/tmux.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import { GeminiProvider } from '../../src/core/providers/gemini.ts';
import { kill } from '../../src/operations/kill.ts';
import { resolveJsonlPath } from '../../src/operations/resolve-jsonl.ts';
import { spawn } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');

let tmpDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-gemini-test-'));
  return { RCTRL_STATE: tmpDir };
}

function sessionName(suffix: string): string {
  // Must pass SessionNameSchema: lowercase, starts with letter/digit
  return `g${RUN_ID}${suffix}`;
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
// Helper: build spawn opts for fake-gemini
// ---------------------------------------------------------------------------

const FAKE_GEMINI = join(import.meta.dir, '../fixtures/fake-gemini.sh');

function makeOpts(
  env: Record<string, string | undefined>,
  cwd: string,
  extra?: Partial<Parameters<typeof spawn>[0]>,
): Parameters<typeof spawn>[0] {
  // Use a dedicated transcript dir inside tmpDir so we control where JSONL lands.
  const transcriptDir = join(tmpDir, 'gemini-transcripts');

  // stop.sh is installed by spawn via ensureGlobalHooks; the path is predictable.
  const hookPath = join(tmpDir, 'hooks', 'stop.sh');

  return {
    cwd,
    provider: 'gemini',
    claudeBin: FAKE_GEMINI,
    env: {
      ...env,
      FAKE_GEMINI_TRANSCRIPT_DIR: transcriptDir,
      FAKE_GEMINI_HOOK: hookPath,
      // RCTRL_SESSION_ID is set by spawn via tmuxEnv, but fake-gemini also
      // reads it. It arrives via the tmux session env — no extra action needed.
    },
    ...extra,
  };
}

// Poll for a file to appear, up to a deadline.
async function waitForFile(path: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// settings.json is written at spawn time
// ---------------------------------------------------------------------------

describe('gemini provider — settings.json written at spawn', () => {
  test('writes <cwd>/.gemini/settings.json with AfterAgent hook before launch', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('s');
    CREATED.push(name);

    await spawn(makeOpts(env, cwd, { name }));

    const settingsPath = join(cwd, '.gemini', 'settings.json');
    // File must exist right after spawn returns — operations layer wrote it.
    expect(existsSync(settingsPath)).toBe(true);

    const raw = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      hooks: {
        AfterAgent: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
      };
    };

    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.AfterAgent).toBeDefined();
    // Verify the hook command references rctrl's stop.sh
    const hookCmd = parsed.hooks.AfterAgent[0]!.hooks[0]!.command;
    expect(hookCmd).toContain('stop.sh');
  });
});

// ---------------------------------------------------------------------------
// Send prompt → hook fires → stop file appears
// ---------------------------------------------------------------------------

describe('gemini provider — end-of-turn detection', () => {
  test('stop event file appears after prompt is processed', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('e');
    CREATED.push(name);

    await spawn(makeOpts(env, cwd, { name }));

    await sendText(name, 'hello');

    const stopPath = join(tmpDir, 'sessions', name, 'events', 'stop');
    const found = await waitForFile(stopPath);
    expect(found).toBe(true);
  });

  test('transcript-path file is written by hook after Stop fires', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('tp');
    CREATED.push(name);

    await spawn(makeOpts(env, cwd, { name }));
    await sendText(name, 'hello');

    const stopPath = join(tmpDir, 'sessions', name, 'events', 'stop');
    await waitForFile(stopPath);

    const transcriptPathFile = join(tmpDir, 'sessions', name, 'events', 'transcript-path');
    const found = await waitForFile(transcriptPathFile);
    expect(found).toBe(true);

    const transcriptPath = (await readFile(transcriptPathFile, 'utf8')).trim();
    expect(transcriptPath.length).toBeGreaterThan(0);
    expect(transcriptPath).toContain('.jsonl');
  });
});

// ---------------------------------------------------------------------------
// resolveJsonlPath + GeminiProvider.parseTranscript
// ---------------------------------------------------------------------------

describe('gemini provider — transcript resolution and parsing', () => {
  test('resolveJsonlPath returns a valid .jsonl path after turn completes', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('rj');
    CREATED.push(name);

    const sinceMs = Date.now();
    await spawn(makeOpts(env, cwd, { name }));
    await sendText(name, 'hello');

    const stopPath = join(tmpDir, 'sessions', name, 'events', 'stop');
    await waitForFile(stopPath);

    const jsonlPath = await resolveJsonlPath({ name, cwd, sinceMs, env });
    expect(jsonlPath).toBeTruthy();
    expect(jsonlPath).toMatch(/\.jsonl$/);
    expect(existsSync(jsonlPath)).toBe(true);
  });

  test('GeminiProvider.parseTranscript extracts assistant text from transcript', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('pt');
    CREATED.push(name);

    const sinceMs = Date.now();
    await spawn(makeOpts(env, cwd, { name }));
    await sendText(name, 'what is 2+2');

    const stopPath = join(tmpDir, 'sessions', name, 'events', 'stop');
    await waitForFile(stopPath);

    const jsonlPath = await resolveJsonlPath({ name, cwd, sinceMs, env });
    const content = await readFile(jsonlPath, 'utf8');

    const result = GeminiProvider.parseTranscript(content);
    // fake-gemini.sh emits "Response to: <prompt>" as the assistant text
    expect(result).toContain('Response to:');
    expect(result).toContain('what is 2+2');
  });
});

// ---------------------------------------------------------------------------
// kill removes settings.json
// ---------------------------------------------------------------------------

describe('gemini provider — kill cleans up settings.json', () => {
  test('kill removes <cwd>/.gemini/settings.json', async () => {
    const env = await setup();
    const cwd = tmpDir;
    const name = sessionName('k');
    // Not pushed to CREATED — kill under test handles cleanup.

    await spawn(makeOpts(env, cwd, { name }));

    const settingsPath = join(cwd, '.gemini', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    await kill({ name, env });

    expect(existsSync(settingsPath)).toBe(false);
  });
});
