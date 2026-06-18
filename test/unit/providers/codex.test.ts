import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CodexProvider } from '../../../src/core/providers/codex.ts';
import { getProvider, PROVIDERS } from '../../../src/core/providers/registry.ts';

// ---------------------------------------------------------------------------
// CodexProvider.buildLaunch
// ---------------------------------------------------------------------------

// codex delivers hooks via a global <stateDir>/codex-home/hooks.json because a
// project .codex/hooks.json is silently ignored inside linked git worktrees
// (see docs/codex-worktree-hooks.md). spawn injects stateDir (umbel state root)
// and userCodexHome (the user's real CODEX_HOME — auth/config source).
const STATE_DIR = '/state';
const USER_CODEX_HOME = '/home/user/.codex';
const CODEX_HOME = join(STATE_DIR, 'codex-home');

type CodexLaunchOpts = Parameters<typeof CodexProvider.buildLaunch>[0];

function launch(extra?: Partial<CodexLaunchOpts>): ReturnType<typeof CodexProvider.buildLaunch> {
  return CodexProvider.buildLaunch({
    sessionId: 'test-session',
    cwd: '/home/user/project',
    hookScriptPath: '/umbel/hooks/stop.sh',
    stateDir: STATE_DIR,
    userCodexHome: USER_CODEX_HOME,
    ...extra,
  });
}

function hooksContent(spec: ReturnType<typeof CodexProvider.buildLaunch>): string {
  const f = spec.files.find((x) => x.path.endsWith('hooks.json'));
  return f !== undefined && 'content' in f ? f.content : '';
}

describe('CodexProvider.buildLaunch', () => {
  test('returns bin=codex', () => {
    expect(launch().bin).toBe('codex');
  });

  test('without model, --model flag is absent', () => {
    expect(launch().args).not.toContain('--model');
  });

  test('with model, args contain --model flag and value', () => {
    const spec = launch({ model: 'o4-mini' });
    expect(spec.args).toContain('--model');
    expect(spec.args).toContain('o4-mini');
  });

  // permissionMode: codex's unattended equivalent of claude's bypassPermissions.
  // An auditor runs commands in a disposable worktree with no human present, so
  // codex must skip its approval prompts (+ sandbox) or it blocks on the prompt.
  test('with permissionMode bypassPermissions, args include codex approvals+sandbox bypass', () => {
    expect(launch({ permissionMode: 'bypassPermissions' }).args).toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  test('without permissionMode, no approvals bypass flag', () => {
    expect(launch().args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('env.CODEX_HOME points at the umbel-managed codex-home under stateDir', () => {
    expect(launch().env.CODEX_HOME).toBe(CODEX_HOME);
  });

  test('hooks.json is written into CODEX_HOME (shared), never the worker cwd', () => {
    const spec = launch();
    const hooks = spec.files.find((f) => f.path === join(CODEX_HOME, 'hooks.json'));
    expect(hooks).toBeDefined();
    expect(hooks?.shared).toBe(true);
    expect(spec.files.some((f) => f.path.startsWith('/home/user/project'))).toBe(false);
  });

  test('auth.json is symlinked from the user CODEX_HOME (shared, no secret copy)', () => {
    const auth = launch().files.find((f) => f.path === join(CODEX_HOME, 'auth.json'));
    expect(auth).toMatchObject({ symlinkTo: join(USER_CODEX_HOME, 'auth.json'), shared: true });
  });

  test('config.toml is copied from the user CODEX_HOME if absent (model/endpoint/MCP)', () => {
    const cfg = launch().files.find((f) => f.path === join(CODEX_HOME, 'config.toml'));
    expect(cfg).toMatchObject({
      copyFrom: join(USER_CODEX_HOME, 'config.toml'),
      ifAbsent: true,
      shared: true,
    });
  });

  test('with notifyScriptPath, hooks.json registers a PermissionRequest hook', () => {
    const notify = '/umbel/hooks/notify.sh';
    const content = hooksContent(launch({ notifyScriptPath: notify }));
    expect(content).toContain('PermissionRequest');
    expect(content).toContain(notify);
  });

  test('hooks.json content is valid JSON with Stop → hookScriptPath', () => {
    const parsed = JSON.parse(hooksContent(launch())) as unknown;
    expect(parsed).toMatchObject({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/umbel/hooks/stop.sh' }] }] },
    });
  });

  test('hooks.json timeout is in seconds (Codex convention, not ms)', () => {
    const parsed = JSON.parse(hooksContent(launch())) as {
      hooks: { Stop: Array<{ hooks: Array<{ timeout: number }> }> };
    };
    const timeout = parsed.hooks.Stop[0]?.hooks[0]?.timeout;
    expect(typeof timeout).toBe('number');
    expect(timeout).toBeLessThan(300);
  });

  test('the hooks.json entry is mode 0o644', () => {
    const hooks = launch().files.find((f) => f.path === join(CODEX_HOME, 'hooks.json'));
    expect(hooks !== undefined && 'mode' in hooks ? hooks.mode : undefined).toBe(0o644);
  });
});

// ---------------------------------------------------------------------------
// CodexProvider.stopEventName
// ---------------------------------------------------------------------------

describe('CodexProvider.stopEventName', () => {
  test('is Stop', () => {
    expect(CodexProvider.stopEventName).toBe('Stop');
  });
});

// ---------------------------------------------------------------------------
// CodexProvider.parseTranscript
// ---------------------------------------------------------------------------

// Inline fixture JSONL matching the Codex rollout envelope exactly as produced
// by fake-codex.sh.
function makeSessionMeta(sessionId: string): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: '2026-05-22T10:00:00Z',
      cwd: '/tmp',
      originator: 'codex',
      cli_version: '0.1.0',
      model_provider: 'openai',
    },
  });
}

function makeResponseItem(text: string): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
}

function makeUserMsg(text: string): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:01.100Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  });
}

function makeAgentMsg(text: string): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:05.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: text },
  });
}

function makeTaskComplete(): string {
  return JSON.stringify({
    timestamp: '2026-05-22T10:00:05.100Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 },
    },
  });
}

function lines(...entries: string[]): string {
  return `${entries.join('\n')}\n`;
}

describe('CodexProvider.parseTranscript', () => {
  test('extracts agent_message text from a single-turn transcript', () => {
    const content = lines(
      makeSessionMeta('session-1'),
      makeResponseItem('hello'),
      makeUserMsg('hello'),
      makeAgentMsg('Hello! How can I help you?'),
      makeTaskComplete(),
    );
    expect(CodexProvider.parseTranscript(content)).toBe('Hello! How can I help you?');
  });

  test('returns the LAST agent_message (ignores earlier turns)', () => {
    const content = lines(
      makeSessionMeta('session-1'),
      makeResponseItem('first'),
      makeUserMsg('first'),
      makeAgentMsg('First answer.'),
      makeTaskComplete(),
      makeResponseItem('second'),
      makeUserMsg('second'),
      makeAgentMsg('Second answer.'),
      makeTaskComplete(),
    );
    const result = CodexProvider.parseTranscript(content);
    expect(result).toBe('Second answer.');
    expect(result).not.toContain('First answer.');
  });

  test('returns empty string for empty content', () => {
    expect(CodexProvider.parseTranscript('')).toBe('');
  });

  test('returns empty string for whitespace-only content', () => {
    expect(CodexProvider.parseTranscript('\n\n  \n')).toBe('');
  });

  test('returns empty string when no agent_message record exists', () => {
    const content = lines(
      makeSessionMeta('session-1'),
      makeResponseItem('hi'),
      makeUserMsg('hi'),
      makeTaskComplete(),
    );
    expect(CodexProvider.parseTranscript(content)).toBe('');
  });

  test('skips malformed JSON lines silently (pure function, no throw)', () => {
    const content = lines(
      makeSessionMeta('session-1'),
      'not-valid-json',
      makeAgentMsg('Valid response.'),
      makeTaskComplete(),
    );
    expect(CodexProvider.parseTranscript(content)).toBe('Valid response.');
  });

  test('ignores event_msg lines where payload.type is not agent_message', () => {
    const content = lines(makeSessionMeta('session-1'), makeUserMsg('hi'), makeTaskComplete());
    expect(CodexProvider.parseTranscript(content)).toBe('');
  });

  test('ignores non-event_msg records even if payload looks like agent_message', () => {
    // A response_item that happens to have payload.type === 'agent_message' is NOT matched
    const impostor = JSON.stringify({
      timestamp: '2026-05-22T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'agent_message', message: 'should not appear' },
    });
    const content = lines(impostor, makeAgentMsg('Real answer.'));
    expect(CodexProvider.parseTranscript(content)).toBe('Real answer.');
  });
});

// ---------------------------------------------------------------------------
// CodexProvider.anchorStrategy
// ---------------------------------------------------------------------------

describe('CodexProvider.anchorStrategy', () => {
  test('is undefined (Codex uses hook-based lifecycle)', () => {
    expect(CodexProvider.anchorStrategy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('PROVIDERS registry', () => {
  test('codex is registered', () => {
    expect(PROVIDERS.codex).toBeDefined();
    expect(PROVIDERS.codex).toBe(CodexProvider);
  });
});

describe('getProvider', () => {
  test('returns CodexProvider for "codex"', () => {
    const provider = getProvider('codex');
    expect(provider).toBe(CodexProvider);
  });
});
