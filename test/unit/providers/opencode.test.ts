import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OpenCodeProvider,
  opencodePluginShouldFire,
  opencodePluginShouldFireNotification,
  opencodePluginShouldFireTurnStart,
  PLUGIN_SOURCE,
} from '../../../src/core/providers/opencode.ts';

// ---------------------------------------------------------------------------
// Sample opencode export JSON (as produced by `opencode export <sessionId>`)
// ---------------------------------------------------------------------------

function makeExportJson(messages: Array<{ role: string; textParts: string[] }>): string {
  return JSON.stringify({
    info: {
      id: 'ses_abc123',
      slug: 'test-session',
      projectID: 'global',
      directory: '/tmp/test',
      title: 'Test session',
      model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' },
      version: '1.15.12',
    },
    messages: messages.map((m) => ({
      info: { role: m.role },
      parts: m.textParts.map((t) => ({ type: 'text', text: t })),
    })),
  });
}

// ---------------------------------------------------------------------------
// OpenCodeProvider.parseTranscript
// ---------------------------------------------------------------------------

describe('OpenCodeProvider.parseTranscript', () => {
  test('returns text from last assistant message — single turn', () => {
    const content = makeExportJson([
      { role: 'user', textParts: ['say hello'] },
      { role: 'assistant', textParts: ['OPENCODE_OK'] },
    ]);
    expect(OpenCodeProvider.parseTranscript(content)).toBe('OPENCODE_OK');
  });

  test('returns text from the LAST assistant message when multiple exist', () => {
    const content = makeExportJson([
      { role: 'user', textParts: ['first'] },
      { role: 'assistant', textParts: ['first answer'] },
      { role: 'user', textParts: ['second'] },
      { role: 'assistant', textParts: ['OPENCODE_OK'] },
    ]);
    const result = OpenCodeProvider.parseTranscript(content);
    expect(result).toBe('OPENCODE_OK');
    expect(result).not.toContain('first answer');
  });

  test('concatenates multiple text parts of the last assistant message', () => {
    const content = makeExportJson([
      { role: 'user', textParts: ['hi'] },
      { role: 'assistant', textParts: ['part one ', 'part two'] },
    ]);
    expect(OpenCodeProvider.parseTranscript(content)).toBe('part one part two');
  });

  test('ignores non-text parts in last assistant message', () => {
    const exportObj = {
      info: {
        id: 'ses_x',
        slug: 'x',
        projectID: 'global',
        directory: '/tmp',
        title: 'x',
        model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' },
        version: '1.15.12',
      },
      messages: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'hello' }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'thinking...' },
            { type: 'text', text: 'OPENCODE_OK' },
            { type: 'step-finish', reason: 'stop' },
          ],
        },
      ],
    };
    expect(OpenCodeProvider.parseTranscript(JSON.stringify(exportObj))).toBe('OPENCODE_OK');
  });

  test('skips trailing non-assistant messages to find last assistant (system metadata)', () => {
    // Mirrors real opencode: export may append metadata entries after the assistant message
    const exportObj = {
      info: {
        id: 'ses_x',
        slug: 'x',
        projectID: 'global',
        directory: '/tmp',
        title: 'x',
        model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' },
        version: '1.15.12',
      },
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'OPENCODE_OK' }] },
        { info: { role: 'system' }, parts: [{ type: 'text', text: 'some metadata' }] },
      ],
    };
    expect(OpenCodeProvider.parseTranscript(JSON.stringify(exportObj))).toBe('OPENCODE_OK');
  });

  test('returns empty string for empty string input (no throw)', () => {
    expect(OpenCodeProvider.parseTranscript('')).toBe('');
  });

  test('returns empty string for whitespace-only input (no throw)', () => {
    expect(OpenCodeProvider.parseTranscript('   \n  ')).toBe('');
  });

  test('returns empty string for malformed JSON (no throw)', () => {
    expect(OpenCodeProvider.parseTranscript('not valid json')).toBe('');
  });

  test('returns empty string when messages array is empty', () => {
    const content = makeExportJson([]);
    expect(OpenCodeProvider.parseTranscript(content)).toBe('');
  });

  test('returns empty string when no assistant messages exist', () => {
    const content = makeExportJson([{ role: 'user', textParts: ['hi'] }]);
    expect(OpenCodeProvider.parseTranscript(content)).toBe('');
  });

  test('returns empty string when assistant message has no text parts', () => {
    const exportObj = {
      info: {
        id: 'ses_x',
        slug: 'x',
        projectID: 'global',
        directory: '/tmp',
        title: 'x',
        model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' },
        version: '1.15.12',
      },
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
        {
          info: { role: 'assistant' },
          parts: [{ type: 'step-start' }, { type: 'step-finish', reason: 'stop' }],
        },
      ],
    };
    expect(OpenCodeProvider.parseTranscript(JSON.stringify(exportObj))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// OpenCodeProvider.exportTranscript
// ---------------------------------------------------------------------------

describe('OpenCodeProvider.exportTranscript', () => {
  test('returns ["opencode", "export", sessionId]', () => {
    expect(OpenCodeProvider.exportTranscript?.('ses_x')).toEqual(['opencode', 'export', 'ses_x']);
  });

  test('uses the provided sessionId verbatim', () => {
    const id = 'ses_18bd6934fffeUtJ410PvuGHVbo';
    const result = OpenCodeProvider.exportTranscript?.(id);
    expect(result).toEqual(['opencode', 'export', id]);
  });
});

// ---------------------------------------------------------------------------
// OpenCodeProvider.buildLaunch
// ---------------------------------------------------------------------------

describe('OpenCodeProvider.buildLaunch', () => {
  const baseOpts = {
    sessionId: 'test-session',
    cwd: '/tmp/proj',
    hookScriptPath: '/home/user/.umbel/hooks/opencode-stop.ts',
  };

  test('bin is "opencode"', () => {
    const spec = OpenCodeProvider.buildLaunch(baseOpts);
    expect(spec.bin).toBe('opencode');
  });

  test('files is empty array (opencode uses global plugin config, not cwd files)', () => {
    const spec = OpenCodeProvider.buildLaunch(baseOpts);
    expect(spec.files).toEqual([]);
  });

  test('disables the autoupdate check that opens a modal over the input box', () => {
    const spec = OpenCodeProvider.buildLaunch(baseOpts);
    expect(spec.env).toEqual({ OPENCODE_DISABLE_AUTOUPDATE: '1' });
  });

  test('without model, args is empty', () => {
    const spec = OpenCodeProvider.buildLaunch(baseOpts);
    expect(spec.args).toEqual([]);
  });

  test('with model, args is ["-m", model]', () => {
    const spec = OpenCodeProvider.buildLaunch({
      ...baseOpts,
      model: 'anthropic/claude-sonnet-4-5',
    });
    expect(spec.args).toEqual(['-m', 'anthropic/claude-sonnet-4-5']);
  });

  test('free model passes through unchanged', () => {
    const spec = OpenCodeProvider.buildLaunch({ ...baseOpts, model: 'opencode/big-pickle' });
    expect(spec.args).toEqual(['-m', 'opencode/big-pickle']);
  });
});

// ---------------------------------------------------------------------------
// OpenCodeProvider static fields
// ---------------------------------------------------------------------------

describe('OpenCodeProvider static fields', () => {
  test('name is "opencode"', () => {
    expect(OpenCodeProvider.name).toBe('opencode');
  });

  test('stopEventName is "session.status"', () => {
    expect(OpenCodeProvider.stopEventName).toBe('session.status');
  });

  test('turnStartEvent is "turn-start", written when a submitted prompt starts a turn', () => {
    expect(OpenCodeProvider.turnStartEvent).toBe('turn-start');
  });

  test('startupDialogs is an empty array', () => {
    expect(OpenCodeProvider.startupDialogs).toEqual([]);
  });

  test('readyMatch matches "Ask anything..."', () => {
    expect(OpenCodeProvider.readyMatch?.test('Ask anything...')).toBe(true);
  });

  test('readyMatch matches "Build · "', () => {
    expect(OpenCodeProvider.readyMatch?.test('Build · ')).toBe(true);
  });

  test('readyMatch does not match unrelated strings', () => {
    expect(OpenCodeProvider.readyMatch?.test('some random text')).toBe(false);
  });

  test('anchorStrategy is undefined (opencode uses plugin-based lifecycle)', () => {
    expect(OpenCodeProvider.anchorStrategy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// opencodePluginShouldFire — pure gating predicate the bundled plugin uses.
// CRITICAL safety property: the globally-installed plugin must NO-OP during the
// user's normal opencode use (UMBEL_SESSION_ID absent), and only act on
// end-of-turn (session.status idle) under an umbel-driven session.
// ---------------------------------------------------------------------------

describe('opencodePluginShouldFire (plugin env-gating)', () => {
  const idle = { type: 'session.status', properties: { status: { type: 'idle' } } };
  const umbelEnv = { UMBEL_STATE: '/tmp/state', UMBEL_SESSION_ID: 'sess1' };

  test('fires on session.status idle under umbel (both env vars set)', () => {
    expect(opencodePluginShouldFire(idle, umbelEnv)).toBe(true);
  });

  test('does NOT fire when UMBEL_SESSION_ID is absent (normal opencode use)', () => {
    expect(opencodePluginShouldFire(idle, { UMBEL_STATE: '/tmp/state' })).toBe(false);
  });

  test('does NOT fire when UMBEL_STATE is absent', () => {
    expect(opencodePluginShouldFire(idle, { UMBEL_SESSION_ID: 'sess1' })).toBe(false);
  });

  test('does NOT fire on a non-idle status (busy)', () => {
    const busy = { type: 'session.status', properties: { status: { type: 'busy' } } };
    expect(opencodePluginShouldFire(busy, umbelEnv)).toBe(false);
  });

  test('does NOT fire on a different event type', () => {
    expect(opencodePluginShouldFire({ type: 'message.updated', properties: {} }, umbelEnv)).toBe(
      false,
    );
  });

  test('does not throw on a malformed event', () => {
    expect(opencodePluginShouldFire({}, umbelEnv)).toBe(false);
  });
});

describe('opencodePluginShouldFireTurnStart (the prompt started a turn)', () => {
  const busy = { type: 'session.status', properties: { status: { type: 'busy' } } };
  const umbelEnv = { UMBEL_STATE: '/tmp/state', UMBEL_SESSION_ID: 'sess1' };

  test('fires on session.status busy under umbel', () => {
    expect(opencodePluginShouldFireTurnStart(busy, umbelEnv)).toBe(true);
  });

  test('does NOT fire on idle (that is the stop signal)', () => {
    const idle = { type: 'session.status', properties: { status: { type: 'idle' } } };
    expect(opencodePluginShouldFireTurnStart(idle, umbelEnv)).toBe(false);
  });

  test("does NOT fire during the user's own opencode use (no umbel env)", () => {
    expect(opencodePluginShouldFireTurnStart(busy, {})).toBe(false);
  });

  test('does not throw on a malformed event', () => {
    expect(opencodePluginShouldFireTurnStart({}, umbelEnv)).toBe(false);
  });
});

describe('opencodePluginShouldFireNotification (permission detection)', () => {
  const umbelEnv = { UMBEL_STATE: '/tmp/state', UMBEL_SESSION_ID: 'sess1' };

  test('fires on permission.updated under umbel (worker blocked on approval)', () => {
    const ev = { type: 'permission.updated', properties: { sessionID: 's', title: 'Bash' } };
    expect(opencodePluginShouldFireNotification(ev, umbelEnv)).toBe(true);
  });

  test('does NOT fire on session.status idle (that is the stop signal, not input)', () => {
    const idle = { type: 'session.status', properties: { status: { type: 'idle' } } };
    expect(opencodePluginShouldFireNotification(idle, umbelEnv)).toBe(false);
  });

  test('does NOT fire without the umbel env vars', () => {
    const ev = { type: 'permission.updated', properties: {} };
    expect(opencodePluginShouldFireNotification(ev, { UMBEL_STATE: '/tmp' })).toBe(false);
  });

  test('does not throw on a malformed event', () => {
    expect(opencodePluginShouldFireNotification({}, umbelEnv)).toBe(false);
  });
});

describe('PLUGIN_SOURCE turn-start handler', () => {
  test('writes events/turn-start on session.status busy', () => {
    expect(PLUGIN_SOURCE).toContain('"busy"');
    expect(PLUGIN_SOURCE).toContain('"turn-start"');
  });
});

describe('PLUGIN_SOURCE notification handler', () => {
  test('handles permission.updated and writes the notification event', () => {
    expect(PLUGIN_SOURCE).toContain('permission.updated');
    expect(PLUGIN_SOURCE).toContain('notification');
  });

  test('appends a structured JSON line (hook_event_name), not a clobbered string', () => {
    expect(PLUGIN_SOURCE).toContain('appendFile');
    expect(PLUGIN_SOURCE).toContain('hook_event_name');
  });
});

// ---------------------------------------------------------------------------
// Identity (jahala/umbel#118)
// ---------------------------------------------------------------------------

const ocEnv = { UMBEL_STATE: '/tmp/state', UMBEL_SESSION_ID: 'worker' };
const status = (sessionID: string, type: 'busy' | 'idle') => ({
  type: 'session.status',
  properties: { sessionID, status: { type } },
});
const permission = (sessionID: string) => ({
  type: 'permission.updated',
  properties: { sessionID, type: 'bash', title: 'Bash' },
});

describe('opencode plugin identity', () => {
  const env = ocEnv;
  test('a bound worker fires only its own session events', () => {
    expect(opencodePluginShouldFireTurnStart(status('ses_own', 'busy'), env, 'ses_own')).toBe(true);
    expect(opencodePluginShouldFire(status('ses_own', 'idle'), env, 'ses_own')).toBe(true);
    expect(opencodePluginShouldFireNotification(permission('ses_own'), env, 'ses_own')).toBe(true);

    expect(opencodePluginShouldFireTurnStart(status('ses_nested', 'busy'), env, 'ses_own')).toBe(
      false,
    );
    expect(opencodePluginShouldFire(status('ses_nested', 'idle'), env, 'ses_own')).toBe(false);
    expect(opencodePluginShouldFireNotification(permission('ses_nested'), env, 'ses_own')).toBe(
      false,
    );
  });

  test('with nothing bound yet, today behaviour stands', () => {
    expect(opencodePluginShouldFire(status('ses_any', 'idle'), env, undefined)).toBe(true);
  });

  test('an event that carries no session id cannot be the bound session', () => {
    const anonymous = { type: 'session.status', properties: { status: { type: 'idle' } } };
    expect(opencodePluginShouldFire(anonymous, env, 'ses_own')).toBe(false);
  });
});

describe('PLUGIN_SOURCE identity binding', () => {
  test('binds the first session and then ignores every other session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbel-oc-plugin-'));
    const prevState = process.env.UMBEL_STATE;
    const prevSession = process.env.UMBEL_SESSION_ID;
    try {
      process.env.UMBEL_STATE = dir;
      process.env.UMBEL_SESSION_ID = 'worker';
      const file = join(dir, 'opencode-plugin.ts');
      await writeFile(file, PLUGIN_SOURCE, 'utf8');
      const mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)) as {
        Plugin: () => Promise<{ event: (input: { event: unknown }) => Promise<void> }>;
      };
      const plugin = await mod.Plugin();
      const events = join(dir, 'sessions', 'worker', 'events');

      await plugin.event({ event: status('ses_own', 'busy') });
      expect(await readFile(join(events, 'worker-session'), 'utf8')).toBe('ses_own');
      expect(existsSync(join(events, 'turn-start'))).toBe(true);

      await plugin.event({ event: status('ses_nested', 'idle') });
      expect(existsSync(join(events, 'stop'))).toBe(false);
      expect(existsSync(join(events, 'session-id'))).toBe(false);

      await plugin.event({ event: status('ses_own', 'idle') });
      expect(existsSync(join(events, 'stop'))).toBe(true);
      expect(await readFile(join(events, 'session-id'), 'utf8')).toBe('ses_own');

      await plugin.event({ event: permission('ses_nested') });
      expect(existsSync(join(events, 'notification'))).toBe(false);
      await plugin.event({ event: permission('ses_own') });
      expect(existsSync(join(events, 'notification'))).toBe(true);
    } finally {
      if (prevState === undefined) delete process.env.UMBEL_STATE;
      else process.env.UMBEL_STATE = prevState;
      if (prevSession === undefined) delete process.env.UMBEL_SESSION_ID;
      else process.env.UMBEL_SESSION_ID = prevSession;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// OpenCodeProvider.extractUsage — an export carries one assistant message per
// API call, each with info.tokens and info.modelID. The newest turn is every
// assistant message after the last user message.
// ---------------------------------------------------------------------------

type OcTokens = {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { write?: number; read?: number };
};

function makeExportWithUsage(
  messages: Array<{ role: string; tokens?: OcTokens; modelID?: string }>,
): string {
  return JSON.stringify({
    info: {
      id: 'ses_abc123',
      slug: 'test-session',
      projectID: 'global',
      directory: '/tmp/test',
      title: 'Test session',
      model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' },
      version: '1.15.12',
    },
    messages: messages.map((m) => ({
      info: {
        role: m.role,
        ...(m.modelID !== undefined ? { modelID: m.modelID } : {}),
        ...(m.tokens !== undefined ? { tokens: m.tokens } : {}),
      },
      parts: [{ type: 'text', text: m.role }],
    })),
  });
}

function opencodeUsage(content: string) {
  if (OpenCodeProvider.extractUsage === undefined) {
    throw new Error('opencode has no extractUsage');
  }
  return OpenCodeProvider.extractUsage(content);
}

describe('OpenCodeProvider.extractUsage', () => {
  test('reads tokens and model from the newest assistant message', () => {
    const content = makeExportWithUsage([
      { role: 'user' },
      {
        role: 'assistant',
        modelID: 'big-pickle',
        tokens: {
          total: 100,
          input: 80,
          output: 10,
          reasoning: 0,
          cache: { write: 3, read: 10 },
        },
      },
    ]);
    expect(opencodeUsage(content)).toEqual({
      inputTokens: 80,
      outputTokens: 10,
      cacheReadTokens: 10,
      cacheWriteTokens: 3,
      model: 'big-pickle',
    });
  });

  test('sums every assistant message after the last user message', () => {
    const content = makeExportWithUsage([
      { role: 'user' },
      {
        role: 'assistant',
        modelID: 'old-model',
        tokens: { input: 1000, output: 100, cache: { write: 0, read: 500 } },
      },
      { role: 'user' },
      {
        role: 'assistant',
        modelID: 'big-pickle',
        tokens: { input: 200, output: 20, cache: { write: 0, read: 50 } },
      },
      {
        role: 'assistant',
        modelID: 'big-pickle',
        tokens: { input: 300, output: 30, cache: { write: 5, read: 70 } },
      },
    ]);
    expect(opencodeUsage(content)).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 120,
      cacheWriteTokens: 5,
      model: 'big-pickle',
    });
  });

  test('an assistant message without tokens contributes nothing', () => {
    const content = makeExportWithUsage([
      { role: 'user' },
      { role: 'assistant', modelID: 'big-pickle' },
    ]);
    expect(opencodeUsage(content)).toBeUndefined();
  });

  test('malformed input yields undefined', () => {
    expect(opencodeUsage('not json')).toBeUndefined();
    expect(opencodeUsage('')).toBeUndefined();
  });
});
