import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UmbelUsageError } from '../../src/core/errors.ts';
import { SessionSchema } from '../../src/core/types.ts';
import { diff } from '../../src/operations/diff.ts';

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

async function setupClaudeSession(opts: {
  name: string;
  turns?: string[];
  jsonlPath?: string | null;
}): Promise<{ env: Record<string, string | undefined> }> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-diff-test-'));
  const env = { UMBEL_STATE: tmpDir };

  const sessionDir = join(tmpDir, 'sessions', opts.name);
  await mkdir(join(sessionDir, 'events'), { recursive: true });

  const jsonlPath = opts.jsonlPath ?? join(tmpDir, `${opts.name}.jsonl`);

  if (opts.turns !== undefined) {
    const lines: string[] = [];
    for (const text of opts.turns) {
      lines.push(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'q' }] },
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
          },
        }),
      );
    }
    await writeFile(jsonlPath, lines.join('\n'), 'utf8');
  }

  const meta = SessionSchema.parse({
    name: opts.name,
    cwd: '/tmp',
    provider: 'claude',
    anonymous: false,
    createdAt: Date.now(),
    jsonlPath: opts.jsonlPath === null ? null : jsonlPath,
  });
  await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta), 'utf8');

  return { env };
}

// ---------------------------------------------------------------------------
// diff operation
// ---------------------------------------------------------------------------

describe('diff operation', () => {
  test('returns "(no transcript yet)" when jsonlPath is null', async () => {
    const { env } = await setupClaudeSession({ name: 's1', jsonlPath: null });
    expect(await diff({ name: 's1', env })).toBe('(no transcript yet)');
  });

  test('returns "(no completed turns yet)" when transcript is empty', async () => {
    const { env } = await setupClaudeSession({ name: 's2', turns: [] });
    expect(await diff({ name: 's2', env })).toBe('(no completed turns yet)');
  });

  test('returns "(only one turn so far)" when one turn and no indices', async () => {
    const { env } = await setupClaudeSession({ name: 's3', turns: ['hello'] });
    expect(await diff({ name: 's3', env })).toBe(
      '(only one turn so far — nothing to diff against)',
    );
  });

  test('default (no indices, 2 turns) → diffs latest vs previous', async () => {
    const { env } = await setupClaudeSession({
      name: 's4',
      turns: ['line one\nline two\nline three', 'line one\nLINE TWO\nline three'],
    });
    const out = await diff({ name: 's4', env });
    expect(out).toContain('--- a/turn 0');
    expect(out).toContain('+++ b/turn 1');
    expect(out).toContain('-line two');
    expect(out).toContain('+LINE TWO');
  });

  test('explicit from/to indices', async () => {
    const { env } = await setupClaudeSession({
      name: 's5',
      turns: ['turn-a', 'turn-b', 'turn-c'],
    });
    const out = await diff({ name: 's5', env, from: 0, to: 2 });
    expect(out).toContain('--- a/turn 0');
    expect(out).toContain('+++ b/turn 2');
    expect(out).toContain('-turn-a');
    expect(out).toContain('+turn-c');
  });

  test('negative from index counts from end', async () => {
    const { env } = await setupClaudeSession({
      name: 's6',
      turns: ['t0', 't1', 't2', 't3'],
    });
    // from: -2 → index 2 (t2); to default → index 3 (t3)
    const out = await diff({ name: 's6', env, from: -2 });
    expect(out).toContain('--- a/turn 2');
    expect(out).toContain('+++ b/turn 3');
    expect(out).toContain('-t2');
    expect(out).toContain('+t3');
  });

  test('identical turns → "(no changes between …)" message', async () => {
    const { env } = await setupClaudeSession({
      name: 's7',
      turns: ['same text', 'same text'],
    });
    const out = await diff({ name: 's7', env });
    expect(out).toBe('(no changes between turn 0 and turn 1)');
  });

  test('out-of-range `to` throws UmbelUsageError', async () => {
    const { env } = await setupClaudeSession({
      name: 's8',
      turns: ['a', 'b'],
    });
    await expect(diff({ name: 's8', env, to: 5 })).rejects.toBeInstanceOf(UmbelUsageError);
  });

  test('out-of-range negative `from` throws UmbelUsageError', async () => {
    const { env } = await setupClaudeSession({
      name: 's9',
      turns: ['a', 'b'],
    });
    await expect(diff({ name: 's9', env, from: -10 })).rejects.toBeInstanceOf(UmbelUsageError);
  });

  // ---------------------------------------------------------------------------
  // Regression: meta.jsonlPath=null + events/transcript-path written
  // ---------------------------------------------------------------------------
  // Same bug class as actions: after Stop, stop.sh writes events/transcript-path
  // but meta.json.jsonlPath remains null. diff() must use resolveJsonlPath, not
  // session.jsonlPath directly. See test/integration/actions.test.ts comment.

  test('meta.jsonlPath=null + events/transcript-path → resolves and diffs (not "(no transcript yet)")', async () => {
    const turn0 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'q1' }] },
    });
    const turn0reply = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'alpha' }],
        stop_reason: 'end_turn',
      },
    });
    const turn1 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    });
    const turn1reply = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'beta' }],
        stop_reason: 'end_turn',
      },
    });
    const jsonl = [turn0, turn0reply, turn1, turn1reply].join('\n');

    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-diff-fallback-'));
    const env = { UMBEL_STATE: tmpDir };
    const name = 'sfallback';
    const sessionDir = join(tmpDir, 'sessions', name);
    await mkdir(join(sessionDir, 'events'), { recursive: true });

    const transcriptPath = join(tmpDir, `${name}.jsonl`);
    await writeFile(transcriptPath, jsonl, 'utf8');
    await writeFile(join(sessionDir, 'events', 'transcript-path'), transcriptPath, 'utf8');

    const meta = SessionSchema.parse({
      name,
      cwd: '/tmp',
      provider: 'claude',
      anonymous: false,
      createdAt: Date.now(),
      jsonlPath: null,
    });
    await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta), 'utf8');

    const out = await diff({ name, env });

    expect(out).not.toContain('(no transcript yet)');
    expect(out).toContain('-alpha');
    expect(out).toContain('+beta');
  });
});
