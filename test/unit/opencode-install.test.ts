import { describe, expect, test } from 'bun:test';
import { mergeOpencodePluginConfig } from '../../src/core/providers/opencode.ts';

// ---------------------------------------------------------------------------
// mergeOpencodePluginConfig
// Pure function. Contract:
//   - null existing  → create { "plugin": [pluginAbsPath] }
//   - existing with other keys → preserve all other keys, add to plugin array
//   - already present → idempotent (no duplicate added)
//   - result must always be valid JSON
// ---------------------------------------------------------------------------

const PLUGIN_PATH = '/home/user/.umbel/hooks/opencode-stop.ts';

describe('mergeOpencodePluginConfig', () => {
  test('null existing → creates config with plugin array containing the path', () => {
    const result = mergeOpencodePluginConfig(null, PLUGIN_PATH);
    const parsed = JSON.parse(result) as { plugin: string[] };
    expect(parsed.plugin).toContain(PLUGIN_PATH);
  });

  test('null existing → plugin array has exactly one entry', () => {
    const result = mergeOpencodePluginConfig(null, PLUGIN_PATH);
    const parsed = JSON.parse(result) as { plugin: string[] };
    expect(parsed.plugin).toHaveLength(1);
    expect(parsed.plugin[0]).toBe(PLUGIN_PATH);
  });

  test('existing with no plugin key → adds plugin array', () => {
    const existing = JSON.stringify({ $schema: 'https://opencode.ai/config.json' });
    const result = mergeOpencodePluginConfig(existing, PLUGIN_PATH);
    const parsed = JSON.parse(result) as { plugin: string[]; $schema: string };
    expect(parsed.plugin).toContain(PLUGIN_PATH);
  });

  test('existing with other keys → preserves all other keys', () => {
    const existing = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: { anthropic: { options: { apiKey: '{env:ANTHROPIC_API_KEY}' } } },
    });
    const result = mergeOpencodePluginConfig(existing, PLUGIN_PATH);
    const parsed = JSON.parse(result) as {
      $schema: string;
      provider: { anthropic: { options: { apiKey: string } } };
      plugin: string[];
    };
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.provider.anthropic.options.apiKey).toBe('{env:ANTHROPIC_API_KEY}');
    expect(parsed.plugin).toContain(PLUGIN_PATH);
  });

  test('existing with plugin array containing other plugins → appends without removing others', () => {
    const otherPlugin = '/home/user/.config/opencode/my-plugin.ts';
    const existing = JSON.stringify({ plugin: [otherPlugin] });
    const result = mergeOpencodePluginConfig(existing, PLUGIN_PATH);
    const parsed = JSON.parse(result) as { plugin: string[] };
    expect(parsed.plugin).toContain(otherPlugin);
    expect(parsed.plugin).toContain(PLUGIN_PATH);
  });

  test('idempotent — re-running with already-present path does not add a duplicate', () => {
    const existing = JSON.stringify({ plugin: [PLUGIN_PATH] });
    const result = mergeOpencodePluginConfig(existing, PLUGIN_PATH);
    const parsed = JSON.parse(result) as { plugin: string[] };
    const count = parsed.plugin.filter((p) => p === PLUGIN_PATH).length;
    expect(count).toBe(1);
  });

  test('idempotent — applying result of previous call produces same result', () => {
    const first = mergeOpencodePluginConfig(null, PLUGIN_PATH);
    const second = mergeOpencodePluginConfig(first, PLUGIN_PATH);
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });

  test('result is always valid JSON', () => {
    const cases = [
      null,
      JSON.stringify({}),
      JSON.stringify({ plugin: [] }),
      JSON.stringify({ plugin: ['/other/plugin.ts'] }),
      JSON.stringify({ $schema: 'x', plugin: [PLUGIN_PATH] }),
    ];
    for (const c of cases) {
      const result = mergeOpencodePluginConfig(c, PLUGIN_PATH);
      expect(() => JSON.parse(result)).not.toThrow();
    }
  });

  test('works with a different plugin path (not hardcoded)', () => {
    const altPath = '/tmp/my-stop.ts';
    const result = mergeOpencodePluginConfig(null, altPath);
    const parsed = JSON.parse(result) as { plugin: string[] };
    expect(parsed.plugin).toContain(altPath);
  });
});
