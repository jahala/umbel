import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDeadError } from '../../src/core/errors.ts';
import type { AgentProvider } from '../../src/core/providers/types.ts';
import { SessionSchema } from '../../src/core/types.ts';
import { resolveTranscriptContent } from '../../src/operations/resolve-transcript.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tmpDir = '';

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

async function makeEnv(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-resolve-transcript-test-'));
  return { UMBEL_STATE: tmpDir };
}

async function makeSession(
  _env: Record<string, string | undefined>,
  name: string,
  jsonlPath: string | null = null,
): Promise<void> {
  const sessionDir = join(tmpDir, 'sessions', name);
  await mkdir(join(sessionDir, 'events'), { recursive: true });
  const meta = SessionSchema.parse({
    name,
    cwd: '/tmp',
    provider: 'claude',
    anonymous: false,
    createdAt: Date.now(),
    jsonlPath,
  });
  await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta), 'utf8');
}

// Fake provider with exportTranscript — simulates the future OpenCode pattern.
const fakeExportProvider: AgentProvider = {
  name: 'x',
  stopEventName: '',
  parseTranscript: (c) => c,
  buildLaunch: () => ({ bin: 'x', args: [], env: {}, files: [] }),
  exportTranscript: (sid) => ['opencode', 'export', sid],
};

// Fake provider without exportTranscript — simulates claude/codex/gemini.
const fakeFileProvider: AgentProvider = {
  name: 'y',
  stopEventName: '',
  parseTranscript: (c) => c,
  buildLaunch: () => ({ bin: 'y', args: [], env: {}, files: [] }),
};

// ---------------------------------------------------------------------------
// Command branch
// ---------------------------------------------------------------------------

describe('resolveTranscriptContent — command branch', () => {
  test('runs exportTranscript argv via deps.exec and returns stdout', async () => {
    const env = await makeEnv();
    const name = 'cmd1';
    await makeSession(env, name);

    // Write the session-id file that the command branch reads
    const eventsDir = join(tmpDir, 'sessions', name, 'events');
    await writeFile(join(eventsDir, 'session-id'), 'ses_test', 'utf8');

    const capturedArgv: string[] = [];
    const fakeExec = {
      run: async (argv: readonly string[]) => {
        capturedArgv.push(...argv);
        return `EXPORTED:${argv.join(' ')}`;
      },
    };

    const result = await resolveTranscriptContent({
      name,
      cwd: '/tmp',
      sinceMs: Date.now(),
      provider: fakeExportProvider,
      env,
      deps: { exec: fakeExec },
    });

    expect(result).toBe('EXPORTED:opencode export ses_test');
    expect(capturedArgv).toEqual(['opencode', 'export', 'ses_test']);
  });

  test('throws SessionDeadError when session-id file is missing', async () => {
    const env = await makeEnv();
    const name = 'cmd2';
    await makeSession(env, name);
    // No session-id file written

    const fakeExec = {
      run: async () => 'should not be called',
    };

    await expect(
      resolveTranscriptContent({
        name,
        cwd: '/tmp',
        sinceMs: Date.now(),
        provider: fakeExportProvider,
        env,
        deps: { exec: fakeExec },
      }),
    ).rejects.toBeInstanceOf(SessionDeadError);
  });

  test('throws SessionDeadError when session-id file is empty', async () => {
    const env = await makeEnv();
    const name = 'cmd3';
    await makeSession(env, name);

    const eventsDir = join(tmpDir, 'sessions', name, 'events');
    await writeFile(join(eventsDir, 'session-id'), '', 'utf8');

    const fakeExec = {
      run: async () => 'should not be called',
    };

    await expect(
      resolveTranscriptContent({
        name,
        cwd: '/tmp',
        sinceMs: Date.now(),
        provider: fakeExportProvider,
        env,
        deps: { exec: fakeExec },
      }),
    ).rejects.toBeInstanceOf(SessionDeadError);
  });
});

// ---------------------------------------------------------------------------
// File branch
// ---------------------------------------------------------------------------

describe('resolveTranscriptContent — file branch', () => {
  test('reads and returns file contents when provider has no exportTranscript', async () => {
    const env = await makeEnv();
    const name = 'file1';
    const jsonlPath = join(tmpDir, `${name}.jsonl`);
    const jsonlContent = '{"type":"assistant","message":"hello"}\n';

    await writeFile(jsonlPath, jsonlContent, 'utf8');
    await makeSession(env, name, jsonlPath);

    const result = await resolveTranscriptContent({
      name,
      cwd: '/tmp',
      sinceMs: Date.now(),
      provider: fakeFileProvider,
      env,
    });

    expect(result).toBe(jsonlContent);
  });

  test('propagates SessionDeadError when all path resolution strategies fail', async () => {
    const env = await makeEnv();
    const name = 'file2';
    // jsonlPath=null in meta, no events/transcript-path, no JSONL on disk
    await makeSession(env, name, null);

    // Inject a fake jsonl adapter that throws SessionDeadError (as the real one would)
    const fakeJsonl = {
      discoverSessionJsonl: async () => {
        throw new SessionDeadError(name, 'not found');
      },
    };

    await expect(
      resolveTranscriptContent({
        name,
        cwd: '/tmp',
        sinceMs: Date.now(),
        provider: fakeFileProvider,
        env,
        deps: { jsonl: fakeJsonl as never },
      }),
    ).rejects.toBeInstanceOf(SessionDeadError);
  });

  test('returns file contents when events/transcript-path points to file (meta.jsonlPath=null)', async () => {
    const env = await makeEnv();
    const name = 'file3';
    const transcriptPath = join(tmpDir, `${name}.jsonl`);
    const content = 'some transcript content\n';

    await writeFile(transcriptPath, content, 'utf8');
    // meta has jsonlPath=null, but events/transcript-path is written (like stop.sh does)
    await makeSession(env, name, null);
    const eventsDir = join(tmpDir, 'sessions', name, 'events');
    await writeFile(join(eventsDir, 'transcript-path'), transcriptPath, 'utf8');

    const result = await resolveTranscriptContent({
      name,
      cwd: '/tmp',
      sinceMs: Date.now(),
      provider: fakeFileProvider,
      env,
    });

    expect(result).toBe(content);
  });
});
