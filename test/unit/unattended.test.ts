/**
 * `unattended` — the neutral contract term for "no human will be prompted".
 *
 * A fleet worker running in a disposable worktree has nobody to answer a
 * permission prompt: it wedges until the wait deadline and the run is lost.
 * Every provider has its own name for the escape, so the contract carries the
 * intent and each adapter maps it. Flags below are verified against the
 * installed binaries' --help, not assumed.
 *
 * Safety for unattended use is external — throwaway worktree, publish through a
 * gate, quarantine — never the prompt.
 */
import { describe, expect, test } from 'bun:test';
import { buildSettingsJson } from '../../src/adapters/hooks.ts';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { GeminiProvider } from '../../src/core/providers/gemini.ts';
import { OpenCodeProvider } from '../../src/core/providers/opencode.ts';

const base = {
  sessionId: 'test-session',
  cwd: '/tmp/test-project',
  hookScriptPath: '/tmp/stop.sh',
};

function geminiArgs(unattended?: boolean): string[] {
  return GeminiProvider.buildLaunch({
    ...base,
    ...(unattended !== undefined ? { unattended } : {}),
  }).args;
}

describe('unattended — every provider declares whether it can run with no human', () => {
  // Declared, not inferred: spawn fails fast at dispatch on a provider that
  // cannot, rather than accepting the spawn and wedging at wait.
  test('all four providers declare unattended support', () => {
    for (const p of [ClaudeProvider, CodexProvider, GeminiProvider, OpenCodeProvider]) {
      expect(p.supportsUnattended).toBe(true);
    }
  });
});

describe('unattended — per-provider flag mapping', () => {
  test('claude bypasses permission checks via its settings default mode', () => {
    const json = buildSettingsJson({ hookScriptPath: '/x/stop.sh', unattended: true });
    const settings = JSON.parse(json) as { permissions?: { defaultMode?: string } };
    expect(settings.permissions?.defaultMode).toBe('bypassPermissions');
  });

  test('claude leaves the default mode alone when attended', () => {
    const json = buildSettingsJson({ hookScriptPath: '/x/stop.sh' });
    const settings = JSON.parse(json) as { permissions?: { defaultMode?: string } };
    expect(settings.permissions?.defaultMode).toBeUndefined();
  });

  test('codex bypasses approvals and sandbox', () => {
    const spec = CodexProvider.buildLaunch({ ...base, unattended: true });
    expect(spec.args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('gemini auto-approves every tool', () => {
    expect(geminiArgs(true)).toContain('--approval-mode');
    expect(geminiArgs(true)).toContain('yolo');
  });

  // gemini is the one provider with a separate trust escape flag, and every
  // fleet worktree is a brand-new directory — so unattended must cover it too.
  test('gemini also skips the workspace-trust prompt', () => {
    expect(geminiArgs(true)).toContain('--skip-trust');
  });

  test('gemini prompts normally when attended', () => {
    expect(geminiArgs()).not.toContain('--approval-mode');
    expect(geminiArgs()).not.toContain('--skip-trust');
  });

  test('opencode auto-approves permissions', () => {
    const spec = OpenCodeProvider.buildLaunch({ ...base, unattended: true });
    expect(spec.args).toContain('--auto');
  });

  test('opencode prompts normally when attended', () => {
    const spec = OpenCodeProvider.buildLaunch({ ...base });
    expect(spec.args).not.toContain('--auto');
  });
});
