/**
 * --permission-mode passthrough for the claude provider.
 *
 * An autonomous worker (driven by a conductor like pleach) cannot answer
 * permission prompts — anything the curated allowedTools list misses (notably
 * MCP tools, whose names are unknowable in advance) blocks the turn. claude's
 * own `--permission-mode bypassPermissions` is the escape; umbel passes it
 * through. Safety for autonomous use is external (sandbox + audit), not prompts.
 */
import { describe, expect, test } from 'bun:test';
import { buildSettingsJson } from '../../src/adapters/hooks.ts';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';

describe('buildSettingsJson — permissionMode', () => {
  test('sets permissions.defaultMode when permissionMode given', () => {
    const json = buildSettingsJson({
      hookScriptPath: '/x/stop.sh',
      permissionMode: 'bypassPermissions',
    });
    const settings = JSON.parse(json) as { permissions?: { defaultMode?: string } };
    expect(settings.permissions?.defaultMode).toBe('bypassPermissions');
  });

  test('omits defaultMode when permissionMode absent', () => {
    const json = buildSettingsJson({ hookScriptPath: '/x/stop.sh' });
    const settings = JSON.parse(json) as { permissions?: { defaultMode?: string } };
    expect(settings.permissions?.defaultMode).toBeUndefined();
  });

  test('coexists with allowedTools (allow + defaultMode together)', () => {
    const json = buildSettingsJson({
      hookScriptPath: '/x/stop.sh',
      allowedTools: 'Read,Bash',
      permissionMode: 'acceptEdits',
    });
    const settings = JSON.parse(json) as {
      permissions?: { allow?: string[]; defaultMode?: string };
    };
    expect(settings.permissions?.allow).toEqual(['Read', 'Bash']);
    expect(settings.permissions?.defaultMode).toBe('acceptEdits');
  });
});

describe('ClaudeProvider.buildLaunch — permissionMode', () => {
  test('embeds defaultMode in the --settings JSON', () => {
    const spec = ClaudeProvider.buildLaunch({
      sessionId: 's',
      cwd: '/tmp',
      hookScriptPath: '/x/stop.sh',
      permissionMode: 'bypassPermissions',
    });
    const idx = spec.args.indexOf('--settings');
    expect(idx).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(spec.args[idx + 1] as string) as {
      permissions?: { defaultMode?: string };
    };
    expect(settings.permissions?.defaultMode).toBe('bypassPermissions');
  });
});

describe('spawn guard — permissionMode (claude + codex)', () => {
  test('a provider without permissionMode support (gemini) throws', async () => {
    const { spawn } = await import('../../src/operations/spawn.ts');
    const { AllowedToolsUnsupportedError } = await import('../../src/core/errors.ts');
    await expect(
      spawn({ name: 'x', cwd: '/tmp', provider: 'gemini', permissionMode: 'bypassPermissions' }),
    ).rejects.toBeInstanceOf(AllowedToolsUnsupportedError);
  });

  test('codex rejects a permission mode other than bypassPermissions', async () => {
    // codex maps only the unattended `bypassPermissions` intent (→ its
    // approvals+sandbox bypass); claude's other named modes are meaningless there.
    const { spawn } = await import('../../src/operations/spawn.ts');
    const { UmbelUsageError } = await import('../../src/core/errors.ts');
    await expect(
      spawn({ name: 'x', cwd: '/tmp', provider: 'codex', permissionMode: 'acceptEdits' }),
    ).rejects.toBeInstanceOf(UmbelUsageError);
  });
});
