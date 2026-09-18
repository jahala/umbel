import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessionJsonl, encodeCwd } from '../../src/adapters/jsonl.ts';
import { SessionDeadError } from '../../src/core/errors.ts';

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

async function setup(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-jsonl-test-'));
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeAssistantLine(text: string, stopReason: string | null = null): string {
  return JSON.stringify({
    parentUuid: 'abc',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
    },
    uuid: 'uuid1',
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// encodeCwd
// ---------------------------------------------------------------------------

describe('encodeCwd', () => {
  test('replaces slashes and spaces with dashes', () => {
    expect(encodeCwd('/Users/you/code/x')).toBe('-Users-you-code-x');
  });

  test('leading slash becomes leading dash', () => {
    expect(encodeCwd('/home/user')).toBe('-home-user');
  });

  test('alphanumeric chars are preserved', () => {
    expect(encodeCwd('/Users/abc123')).toBe('-Users-abc123');
  });

  test('existing dashes pass through', () => {
    // Per findings Q8: replace non-alphanumeric with '-'
    // A dash IS non-alphanumeric so it maps to '-' (same char — idempotent for dashes)
    expect(encodeCwd('/Users/x/y-z')).toBe('-Users-x-y-z');
  });

  test('double slashes produce double dashes', () => {
    expect(encodeCwd('/a//b')).toBe('-a--b');
  });

  test('empty string returns empty string', () => {
    expect(encodeCwd('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// discoverSessionJsonl
// ---------------------------------------------------------------------------

describe('discoverSessionJsonl', () => {
  test('finds a JSONL file created after sinceMs', async () => {
    const dir = await setup();
    const projectsDir = join(dir, 'projects', encodeCwd('/test/cwd'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectsDir, { recursive: true });

    const sinceMs = Date.now();
    const jsonlPath = join(projectsDir, 'session-abc.jsonl');
    await writeFile(jsonlPath, `${makeAssistantLine('hello', 'end_turn')}\n`);

    const found = await discoverSessionJsonl({
      sessionName: 'test',
      cwd: '/test/cwd',
      sinceMs,
      projectsRoot: join(dir, 'projects'),
      timeoutMs: 3000,
    });
    expect(found).toBe(jsonlPath);
  });

  test('ignores files created before sinceMs', async () => {
    const dir = await setup();
    const projectsDir = join(dir, 'projects', encodeCwd('/old/cwd'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectsDir, { recursive: true });

    // Write file first, then set sinceMs to future
    const jsonlPath = join(projectsDir, 'old.jsonl');
    await writeFile(jsonlPath, `${makeAssistantLine('old', 'end_turn')}\n`);
    // Wait to ensure birthtime is in the past
    await Bun.sleep(50);
    const sinceMs = Date.now() + 10000; // future — no file should qualify

    await expect(
      discoverSessionJsonl({
        sessionName: 'test',
        cwd: '/old/cwd',
        sinceMs,
        projectsRoot: join(dir, 'projects'),
        timeoutMs: 500,
      }),
    ).rejects.toBeInstanceOf(SessionDeadError);
  });

  test('returns newest when multiple files qualify', async () => {
    const dir = await setup();
    const projectsDir = join(dir, 'projects', encodeCwd('/multi/cwd'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectsDir, { recursive: true });

    const sinceMs = Date.now() - 1000;
    const pathA = join(projectsDir, 'aaa.jsonl');
    await writeFile(pathA, `${makeAssistantLine('a', 'end_turn')}\n`);
    await Bun.sleep(20);
    const pathB = join(projectsDir, 'bbb.jsonl');
    await writeFile(pathB, `${makeAssistantLine('b', 'end_turn')}\n`);

    const found = await discoverSessionJsonl({
      sessionName: 'test',
      cwd: '/multi/cwd',
      sinceMs,
      projectsRoot: join(dir, 'projects'),
      timeoutMs: 3000,
    });
    expect(found).toBe(pathB);
  });

  test('throws SessionDeadError after timeout when no file appears', async () => {
    const dir = await setup();
    const sinceMs = Date.now();
    await expect(
      discoverSessionJsonl({
        sessionName: 'dead-session',
        cwd: '/no/such/project',
        sinceMs,
        projectsRoot: join(dir, 'projects'),
        timeoutMs: 300,
      }),
    ).rejects.toBeInstanceOf(SessionDeadError);
  });
});
