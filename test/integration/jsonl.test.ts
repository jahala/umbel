import { afterEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessionJsonl, discoverTranscript, encodeCwd } from '../../src/adapters/jsonl.ts';
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

// ---------------------------------------------------------------------------
// discoverTranscript — a provider-described search below a directory tree
// ---------------------------------------------------------------------------

// belongs receives the worker's resolved cwd: the transcript records the path
// the CLI saw, which is the realpath (/private/var/... for /var/...).
function makeSearch(root: string) {
  return {
    dirs: [root],
    depth: 3,
    prefix: 'rollout-',
    suffix: '.jsonl',
    belongs: (firstLine: string, realCwd: string): boolean => {
      const record = JSON.parse(firstLine) as { payload?: { cwd?: string } };
      return record.payload?.cwd === realCwd;
    },
  };
}

describe('discoverTranscript', () => {
  test('finds a rollout nested in year/month/day and skips one that belongs to another cwd', async () => {
    const dir = await setup();
    const root = join(dir, 'sessions');
    const day = join(root, '2026', '10', '22');
    await mkdir(day, { recursive: true });

    const sinceMs = Date.now() - 1000;
    const mine = join(day, 'rollout-mine.jsonl');
    await writeFile(mine, `${JSON.stringify({ payload: { cwd: realpathSync(dir) } })}\n`);
    await Bun.sleep(20);
    // Newer, but its session_meta names a different worker's cwd.
    const other = join(day, 'rollout-other.jsonl');
    await writeFile(other, `${JSON.stringify({ payload: { cwd: '/somewhere/else' } })}\n`);
    await Bun.sleep(20);
    // Newer still, but not a rollout file.
    await writeFile(
      join(day, 'notes.jsonl'),
      `${JSON.stringify({ payload: { cwd: realpathSync(dir) } })}\n`,
    );

    const found = await discoverTranscript({
      sessionName: 'test',
      cwd: dir,
      sinceMs,
      search: makeSearch(root),
      timeoutMs: 1000,
    });
    expect(found).toBe(mine);
  });

  test('ignores files created before sinceMs', async () => {
    const dir = await setup();
    const root = join(dir, 'sessions');
    await mkdir(join(root, '2026', '10', '22'), { recursive: true });
    const path = join(root, '2026', '10', '22', 'rollout-old.jsonl');
    await writeFile(path, `${JSON.stringify({ payload: { cwd: realpathSync(dir) } })}\n`);

    await expect(
      discoverTranscript({
        sessionName: 'test',
        cwd: dir,
        sinceMs: Date.now() + 10_000,
        search: makeSearch(root),
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(SessionDeadError);
  });

  test('throws SessionDeadError when only another cwd matches', async () => {
    const dir = await setup();
    const root = join(dir, 'sessions');
    const day = join(root, '2026', '10', '22');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-other.jsonl'),
      `${JSON.stringify({ payload: { cwd: '/other' } })}\n`,
    );

    await expect(
      discoverTranscript({
        sessionName: 'test',
        cwd: dir,
        sinceMs: Date.now() - 1000,
        search: makeSearch(root),
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(SessionDeadError);
  });

  test('does not walk past the declared depth', async () => {
    const dir = await setup();
    const root = join(dir, 'sessions');
    const tooDeep = join(root, '2026', '10', '22', 'nested');
    await mkdir(tooDeep, { recursive: true });
    await writeFile(
      join(tooDeep, 'rollout-deep.jsonl'),
      `${JSON.stringify({ payload: { cwd: realpathSync(dir) } })}\n`,
    );

    await expect(
      discoverTranscript({
        sessionName: 'test',
        cwd: dir,
        sinceMs: Date.now() - 1000,
        search: makeSearch(root),
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(SessionDeadError);
  });
});
