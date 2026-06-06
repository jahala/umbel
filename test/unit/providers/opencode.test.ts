import { describe, expect, test } from 'bun:test';
import {
  OpenCodeProvider,
  opencodePluginShouldFire,
  opencodePluginShouldFireNotification,
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
    hookScriptPath: '/home/user/.rctrl/hooks/opencode-stop.ts',
  };

  test('bin is "opencode"', () => {
    const spec = OpenCodeProvider.buildLaunch(baseOpts);
    expect(spec.bin).toBe('opencode');
  });

  test('files is empty array (opencode uses global plugin config, not cwd files)', () => {
    const spec = OpenCodeProvider.buildLaunch(baseOpts);
    expect(spec.files).toEqual([]);
  });

  test('env is empty object', () => {
    const spec = OpenCodeProvider.buildLaunch(baseOpts);
    expect(spec.env).toEqual({});
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
// user's normal opencode use (RCTRL_SESSION_ID absent), and only act on
// end-of-turn (session.status idle) under an rctrl-driven session.
// ---------------------------------------------------------------------------

describe('opencodePluginShouldFire (plugin env-gating)', () => {
  const idle = { type: 'session.status', properties: { status: { type: 'idle' } } };
  const rctrlEnv = { RCTRL_STATE: '/tmp/state', RCTRL_SESSION_ID: 'sess1' };

  test('fires on session.status idle under rctrl (both env vars set)', () => {
    expect(opencodePluginShouldFire(idle, rctrlEnv)).toBe(true);
  });

  test('does NOT fire when RCTRL_SESSION_ID is absent (normal opencode use)', () => {
    expect(opencodePluginShouldFire(idle, { RCTRL_STATE: '/tmp/state' })).toBe(false);
  });

  test('does NOT fire when RCTRL_STATE is absent', () => {
    expect(opencodePluginShouldFire(idle, { RCTRL_SESSION_ID: 'sess1' })).toBe(false);
  });

  test('does NOT fire on a non-idle status (busy)', () => {
    const busy = { type: 'session.status', properties: { status: { type: 'busy' } } };
    expect(opencodePluginShouldFire(busy, rctrlEnv)).toBe(false);
  });

  test('does NOT fire on a different event type', () => {
    expect(opencodePluginShouldFire({ type: 'message.updated', properties: {} }, rctrlEnv)).toBe(
      false,
    );
  });

  test('does not throw on a malformed event', () => {
    expect(opencodePluginShouldFire({}, rctrlEnv)).toBe(false);
  });
});

describe('opencodePluginShouldFireNotification (permission detection)', () => {
  const rctrlEnv = { RCTRL_STATE: '/tmp/state', RCTRL_SESSION_ID: 'sess1' };

  test('fires on permission.updated under rctrl (worker blocked on approval)', () => {
    const ev = { type: 'permission.updated', properties: { sessionID: 's', title: 'Bash' } };
    expect(opencodePluginShouldFireNotification(ev, rctrlEnv)).toBe(true);
  });

  test('does NOT fire on session.status idle (that is the stop signal, not input)', () => {
    const idle = { type: 'session.status', properties: { status: { type: 'idle' } } };
    expect(opencodePluginShouldFireNotification(idle, rctrlEnv)).toBe(false);
  });

  test('does NOT fire without the rctrl env vars', () => {
    const ev = { type: 'permission.updated', properties: {} };
    expect(opencodePluginShouldFireNotification(ev, { RCTRL_STATE: '/tmp' })).toBe(false);
  });

  test('does not throw on a malformed event', () => {
    expect(opencodePluginShouldFireNotification({}, rctrlEnv)).toBe(false);
  });
});

describe('PLUGIN_SOURCE notification handler', () => {
  test('handles permission.updated and writes the notification event', () => {
    expect(PLUGIN_SOURCE).toContain('permission.updated');
    expect(PLUGIN_SOURCE).toContain('notification');
  });
});
