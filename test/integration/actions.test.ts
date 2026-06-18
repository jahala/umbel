import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSchema } from '../../src/core/types.ts';
import { actions, formatManifest } from '../../src/operations/actions.ts';

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

async function setupSession(opts: {
  name: string;
  provider: 'claude' | 'codex' | 'gemini';
  jsonlContent?: string;
  jsonlPath?: string | null;
}): Promise<{
  env: Record<string, string | undefined>;
  jsonlPath: string;
}> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-actions-test-'));
  const env = { UMBEL_STATE: tmpDir };

  const sessionDir = join(tmpDir, 'sessions', opts.name);
  await mkdir(join(sessionDir, 'events'), { recursive: true });

  const jsonlPath = opts.jsonlPath ?? join(tmpDir, `${opts.name}.jsonl`);
  if (opts.jsonlContent !== undefined) {
    await writeFile(jsonlPath, opts.jsonlContent, 'utf8');
  }

  const meta = SessionSchema.parse({
    name: opts.name,
    cwd: '/tmp',
    provider: opts.provider,
    anonymous: false,
    createdAt: Date.now(),
    jsonlPath: opts.jsonlPath === null ? null : jsonlPath,
  });
  await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta), 'utf8');

  return { env, jsonlPath };
}

// ---------------------------------------------------------------------------
// actions operation — end-to-end through meta + jsonl
// ---------------------------------------------------------------------------

describe('actions operation', () => {
  test('returns "(no transcript yet)" when jsonlPath is null', async () => {
    const { env } = await setupSession({
      name: 'sess1',
      provider: 'claude',
      jsonlPath: null,
    });
    const out = await actions({ name: 'sess1', env });
    expect(out).toBe('(no transcript yet)');
  });

  test('Codex provider with empty transcript → empty manifest, no crash', async () => {
    // All three shipped providers (Claude, Codex, Gemini) implement
    // extractActions. This test exercises Codex's implementation through the
    // operations layer with empty content — verifies the integration path
    // works for non-Claude providers.
    const { env } = await setupSession({
      name: 'sess2',
      provider: 'codex',
      jsonlContent: '',
    });
    const out = await actions({ name: 'sess2', env });
    expect(out).toContain('## Worker actions (0 turns)');
    expect(out).toContain('(no final message yet)');
  });

  test('Claude session with tool_use blocks → formatted manifest', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'review and fix' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/repo/foo.ts' },
              tool_use_id: 'tu1',
            },
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: '/repo/foo.ts', old_string: 'a', new_string: 'b' },
              tool_use_id: 'tu2',
            },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'bun test' },
              tool_use_id: 'tu3',
            },
          ],
          stop_reason: 'tool_use',
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' },
            { type: 'tool_result', tool_use_id: 'tu2', content: 'edit ok' },
            { type: 'tool_result', tool_use_id: 'tu3', content: 'tests pass' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'All tests pass after the fix.' }],
          stop_reason: 'end_turn',
        },
      }),
    ].join('\n');

    const { env } = await setupSession({
      name: 'sess3',
      provider: 'claude',
      jsonlContent: jsonl,
    });
    const out = await actions({ name: 'sess3', env });

    // Header + structural sections present
    expect(out).toContain('## Worker actions (1 turn)');
    expect(out).toContain('Tools: Read×1, Edit×1, Bash×1');
    expect(out).toContain('Files read: /repo/foo.ts');
    expect(out).toContain('Files edited: /repo/foo.ts');
    expect(out).toContain('Bash:');
    expect(out).toContain('bun test');
    expect(out).toContain('## Final message');
    expect(out).toContain('All tests pass after the fix.');
    // No errors section when no errors
    expect(out).not.toContain('## Errors');
  });

  test('Claude session with errors → manifest includes errors section', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'try' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: '/missing.ts', old_string: 'x', new_string: 'y' },
              tool_use_id: 'tu_err',
            },
          ],
          stop_reason: 'tool_use',
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_err',
              content: 'File not found: /missing.ts',
              is_error: true,
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Failed.' }],
          stop_reason: 'end_turn',
        },
      }),
    ].join('\n');

    const { env } = await setupSession({
      name: 'sess4',
      provider: 'claude',
      jsonlContent: jsonl,
    });
    const out = await actions({ name: 'sess4', env });

    expect(out).toContain('## Errors (1)');
    expect(out).toContain('File not found: /missing.ts');
  });

  test('text-only session (no tool_use) → empty Tools omitted, final message present', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello!' }],
          stop_reason: 'end_turn',
        },
      }),
    ].join('\n');

    const { env } = await setupSession({
      name: 'sess5',
      provider: 'claude',
      jsonlContent: jsonl,
    });
    const out = await actions({ name: 'sess5', env });

    expect(out).toContain('## Worker actions (1 turn)');
    expect(out).not.toContain('Tools:');
    expect(out).not.toContain('Files');
    expect(out).not.toContain('Bash:');
    expect(out).toContain('Hello!');
  });

  // ---------------------------------------------------------------------------
  // Regression: meta.jsonlPath=null + events/transcript-path written
  // ---------------------------------------------------------------------------
  //
  // After Stop fires for the first time, stop.sh writes events/transcript-path
  // with the real JSONL location captured from the hook payload. meta.json's
  // jsonlPath remains null because nobody writes it until something explicitly
  // resolves+persists. Operations that read session.jsonlPath directly will
  // see null and return "(no transcript yet)" even though the data IS
  // available via the fallback chain (resolveJsonlPath handles this).
  //
  // Discovered by live test of umbel_actions against a fresh claude session.

  test('meta.jsonlPath=null + events/transcript-path → reads JSONL via fallback (not "(no transcript yet)")', async () => {
    // Build the JSONL on disk first so we can reference its path.
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'q' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from fallback path.' }],
          stop_reason: 'end_turn',
        },
      }),
    ].join('\n');

    // Manual setup — bypass setupSession because we need jsonlPath=null
    // in meta AND a separate transcript file at a known location.
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-actions-fallback-'));
    const env = { UMBEL_STATE: tmpDir };
    const name = 'sess6';
    const sessionDir = join(tmpDir, 'sessions', name);
    await mkdir(join(sessionDir, 'events'), { recursive: true });

    const transcriptPath = join(tmpDir, `${name}.jsonl`);
    await writeFile(transcriptPath, jsonl, 'utf8');

    // events/transcript-path mirrors what stop.sh writes (just the path string).
    await writeFile(join(sessionDir, 'events', 'transcript-path'), transcriptPath, 'utf8');

    // meta.json has jsonlPath: null — the bug case.
    const meta = SessionSchema.parse({
      name,
      cwd: '/tmp',
      provider: 'claude',
      anonymous: false,
      createdAt: Date.now(),
      jsonlPath: null,
    });
    await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta), 'utf8');

    const out = await actions({ name, env });

    // Pre-fix this returned "(no transcript yet)". Post-fix it resolves the
    // path via events/transcript-path and returns the actual manifest.
    expect(out).not.toContain('(no transcript yet)');
    expect(out).toContain('## Worker actions (1 turn)');
    expect(out).toContain('Hello from fallback path.');
  });
});

// ---------------------------------------------------------------------------
// formatManifest — pure formatter tests
// ---------------------------------------------------------------------------

describe('formatManifest', () => {
  test('handles plural vs singular turn label', () => {
    const base = {
      toolsUsed: {},
      filesRead: [],
      filesEdited: [],
      filesWritten: [],
      bashCommands: [],
      errors: [],
      finalMessage: '',
    };
    expect(formatManifest({ ...base, turnCount: 0 })).toContain('(0 turns)');
    expect(formatManifest({ ...base, turnCount: 1 })).toContain('(1 turn)');
    expect(formatManifest({ ...base, turnCount: 5 })).toContain('(5 turns)');
  });

  test('truncates very long bash commands and replaces newlines', () => {
    const longCmd = 'a'.repeat(500);
    const out = formatManifest({
      toolsUsed: { Bash: 1 },
      filesRead: [],
      filesEdited: [],
      filesWritten: [],
      bashCommands: [longCmd],
      errors: [],
      finalMessage: 'done',
      turnCount: 1,
    });
    expect(out).toContain('a'.repeat(200));
    expect(out).toContain('…');
  });

  test('multiline error becomes one-line with ⏎ marker', () => {
    const out = formatManifest({
      toolsUsed: { Bash: 1 },
      filesRead: [],
      filesEdited: [],
      filesWritten: [],
      bashCommands: ['ls'],
      errors: ['line 1\nline 2\nline 3'],
      finalMessage: 'ok',
      turnCount: 1,
    });
    expect(out).toContain('line 1 ⏎ line 2 ⏎ line 3');
  });

  test('empty finalMessage shows placeholder', () => {
    const out = formatManifest({
      toolsUsed: {},
      filesRead: [],
      filesEdited: [],
      filesWritten: [],
      bashCommands: [],
      errors: [],
      finalMessage: '',
      turnCount: 0,
    });
    expect(out).toContain('(no final message yet)');
  });
});
