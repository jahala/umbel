import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessionJsonl, encodeCwd, lastAssistantMessage } from '../../src/adapters/jsonl.ts';
import { JsonlMalformedError, SessionDeadError } from '../../src/core/errors.ts';

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

async function setup(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-jsonl-test-'));
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

function makeUserLine(text: string): string {
  return JSON.stringify({
    parentUuid: null,
    type: 'human',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    uuid: 'uuid0',
    timestamp: new Date().toISOString(),
  });
}

function joinLines(lines: string[]): string {
  return `${lines.join('\n')}\n`;
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
// lastAssistantMessage
// ---------------------------------------------------------------------------

describe('lastAssistantMessage', () => {
  test('extracts text from simple assistant entry with end_turn', async () => {
    const dir = await setup();
    const path = join(dir, 'simple.jsonl');
    await writeFile(
      path,
      joinLines([makeUserLine('hi'), makeAssistantLine('Hello there!', 'end_turn')]),
    );

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    expect(msg).toBe('Hello there!');
  });

  test('joins multiple streaming assistant entries (none have stop_reason until last)', async () => {
    const dir = await setup();
    const path = join(dir, 'streamed.jsonl');
    await writeFile(
      path,
      joinLines([
        makeUserLine('question'),
        makeAssistantLine('Part one. ', null),
        makeAssistantLine('Part two. ', null),
        makeAssistantLine('Part three.', 'end_turn'),
      ]),
    );

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    expect(msg).toContain('Part one.');
    expect(msg).toContain('Part two.');
    expect(msg).toContain('Part three.');
  });

  test('returns only the last turn (ignores earlier assistant turns)', async () => {
    const dir = await setup();
    const path = join(dir, 'multiturn.jsonl');
    await writeFile(
      path,
      joinLines([
        makeUserLine('first question'),
        makeAssistantLine('First answer.', 'end_turn'),
        makeUserLine('second question'),
        makeAssistantLine('Second answer.', 'end_turn'),
      ]),
    );

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    expect(msg).toBe('Second answer.');
    expect(msg).not.toContain('First answer.');
  });

  test('retries when last group lacks stop_reason; succeeds when fixture flips it', async () => {
    const dir = await setup();
    const path = join(dir, 'retry.jsonl');

    // Write incomplete (no stop_reason on last entry)
    await writeFile(path, joinLines([makeUserLine('q'), makeAssistantLine('Partial...', null)]));

    // Complete it after 100ms
    setTimeout(async () => {
      await writeFile(
        path,
        joinLines([
          makeUserLine('q'),
          makeAssistantLine('Partial...', null),
          makeAssistantLine('Done!', 'end_turn'),
        ]),
      );
    }, 100);

    const msg = await lastAssistantMessage({
      jsonlPath: path,
      retryUntilComplete: true,
      maxRetries: 20,
      retryDelayMs: 80,
    });
    expect(msg).toContain('Done!');
  });

  test('handles content as plain string (defensive shape)', async () => {
    const dir = await setup();
    const path = join(dir, 'plain.jsonl');
    const line = JSON.stringify({
      role: 'assistant',
      content: 'Plain string content.',
    });
    await writeFile(path, `${line}\n`);

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    expect(msg).toBe('Plain string content.');
  });

  test('throws JsonlMalformedError on invalid JSON line', async () => {
    const dir = await setup();
    const path = join(dir, 'bad.jsonl');
    await writeFile(path, 'not json at all!!!\n');

    await expect(
      lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false }),
    ).rejects.toBeInstanceOf(JsonlMalformedError);
  });

  test('returns empty string on empty file', async () => {
    const dir = await setup();
    const path = join(dir, 'empty.jsonl');
    await writeFile(path, '');

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    expect(msg).toBe('');
  });

  // Line 42: msgField is null (message field present but null)
  test('returns null text (skips entry) when message field is null', async () => {
    const dir = await setup();
    const path = join(dir, 'null-message.jsonl');
    // Shape A with message:null — not assistant entry, so no text extracted
    const line = JSON.stringify({ message: null, type: 'system', uuid: 'u1' });
    const assistantLine = JSON.stringify({
      role: 'assistant',
      content: 'Hello from shape B.',
      stop_reason: 'end_turn',
    });
    await writeFile(path, `${line}\n${assistantLine}\n`);

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    // Only the shape-B assistant line contributes
    expect(msg).toBe('Hello from shape B.');
  });

  // Line 48: top-level role==='assistant' with content (shape B, no .message wrapper)
  test('extracts text from top-level role=assistant with content string (shape B)', async () => {
    const dir = await setup();
    const path = join(dir, 'shape-b.jsonl');
    const line = JSON.stringify({
      role: 'assistant',
      content: 'Direct content string.',
      stop_reason: 'end_turn',
    });
    await writeFile(path, `${line}\n`);

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    expect(msg).toBe('Direct content string.');
  });

  // Line 50: line with no recognizable shape — returns null from extractText, falls through
  test('ignores entries with no recognizable shape (no role/message field)', async () => {
    const dir = await setup();
    const path = join(dir, 'unknown-shape.jsonl');
    // An entry with no role and no message — extractText returns null
    const unknownLine = JSON.stringify({ foo: 'bar', baz: 42 });
    const assistantLine = JSON.stringify({
      role: 'assistant',
      content: 'Real content.',
      stop_reason: 'end_turn',
    });
    await writeFile(path, `${unknownLine}\n${assistantLine}\n`);

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    expect(msg).toBe('Real content.');
  });

  // Lines 66-67: content array with non-text blocks (tool_use) — only text parts joined
  test('joins only text blocks from content array (ignores tool_use blocks)', async () => {
    const dir = await setup();
    const path = join(dir, 'mixed-content.jsonl');
    const line = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Part A. ' },
        { type: 'tool_use', id: 'tool1', name: 'Read', input: {} },
        { type: 'text', text: 'Part B.' },
      ],
      stop_reason: 'end_turn',
    });
    await writeFile(path, `${line}\n`);

    const msg = await lastAssistantMessage({ jsonlPath: path, retryUntilComplete: false });
    expect(msg).toBe('Part A. Part B.');
  });

  // Line 89: top-level stop_reason (shape B: no .message wrapper)
  test('detects stop_reason at top level (shape B)', async () => {
    const dir = await setup();
    const path = join(dir, 'stop-reason-top.jsonl');
    // Shape B with top-level stop_reason — hasStopReason checks obj.stop_reason
    const line = JSON.stringify({
      role: 'assistant',
      content: 'Done here.',
      stop_reason: 'end_turn',
    });
    await writeFile(path, `${line}\n`);

    // With retryUntilComplete=true this should NOT retry because stop_reason present
    const msg = await lastAssistantMessage({
      jsonlPath: path,
      retryUntilComplete: true,
      maxRetries: 0,
    });
    expect(msg).toBe('Done here.');
  });

  // Line 205: retry exhaustion — JSONL never gets stop_reason; maxRetries=1 returns text anyway
  test('returns text after retry exhaustion even without stop_reason', async () => {
    const dir = await setup();
    const path = join(dir, 'no-stop-reason.jsonl');
    // Incomplete assistant entry — no stop_reason ever set
    const line = JSON.stringify({
      role: 'assistant',
      content: 'Incomplete response.',
    });
    await writeFile(path, `${line}\n`);

    // maxRetries=1, retryDelayMs=10 — exhausts quickly and returns what it has
    const msg = await lastAssistantMessage({
      jsonlPath: path,
      retryUntilComplete: true,
      maxRetries: 1,
      retryDelayMs: 10,
    });
    // After exhausting retries it returns the incomplete text
    expect(msg).toBe('Incomplete response.');
  });
});
