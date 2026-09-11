import { describe, expect, test } from 'bun:test';
import { mergeOpencodePluginConfig } from '../../src/core/providers/opencode.ts';

// ---------------------------------------------------------------------------
// mergeOpencodePluginConfig
// Pure function over the text of the user's opencode.jsonc. Contract:
//   - null existing          → { kind: 'write', content } creating { "$schema", "plugin": [pluginAbsPath] }
//   - JSONC existing         → { kind: 'write', content } where content is the original text with
//                              one contiguous insertion (the plugin entry); every other byte,
//                              comment, blank line and trailing comma is preserved
//   - path already listed    → { kind: 'unchanged' }
//   - text that is not JSONC → { kind: 'unparsable', line, column, reason } (1-based), never replaced
// JSONC semantics are checked with Bun.JSONC, independent of the implementation's parser.
// ---------------------------------------------------------------------------

const PLUGIN_PATH = '/home/user/.umbel/hooks/opencode-stop.ts';

type JsonObj = Record<string, unknown>;

function writtenContent(result: ReturnType<typeof mergeOpencodePluginConfig>): string {
  expect(result.kind).toBe('write');
  if (result.kind !== 'write') throw new Error(`expected write, got ${result.kind}`);
  return result.content;
}

// The text inserted into `before` to produce `after`, or null when `after` is not
// `before` with exactly one contiguous insertion (i.e. some original byte changed).
function insertedSpan(before: string, after: string): string | null {
  if (after.length < before.length) return null;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (prefix + suffix !== before.length) return null;
  return after.slice(prefix, after.length - suffix);
}

function withoutPlugin(config: JsonObj): JsonObj {
  const { plugin: _plugin, ...rest } = config;
  return rest;
}

// Asserts the merge added PLUGIN_PATH as the last plugin entry and changed nothing else.
function expectOnlyPluginAdded(original: string): string {
  const content = writtenContent(mergeOpencodePluginConfig(original, PLUGIN_PATH));
  const span = insertedSpan(original, content);
  expect(span).not.toBeNull();
  expect(span).toContain(JSON.stringify(PLUGIN_PATH));

  const before = Bun.JSONC.parse(original) as JsonObj;
  const after = Bun.JSONC.parse(content) as JsonObj;
  const priorPlugins = Array.isArray(before.plugin) ? before.plugin : [];
  expect(after.plugin).toEqual([...priorPlugins, PLUGIN_PATH]);
  expect(withoutPlugin(after)).toEqual(withoutPlugin(before));
  return content;
}

// jahala/umbel#53, Case A, verbatim: a `//` comment inside a provider block.
const CASE_A = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["~/.umbel/hooks/opencode-stop.ts"],
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      // this comment is legal JSONC and accepted by opencode
      "models": { "some-model": { "name": "Some Model" } }
    }
  }
}
`;

const BLOCK_COMMENT_NO_PLUGIN = `/* opencode config, hand-edited */
{
  "$schema": "https://opencode.ai/config.json",

  /*
   * Local models only.
   */
  "model": "ollama/some-model",

  "provider": { "ollama": { "options": { "baseURL": "http://localhost:11434/v1" } } }
}
`;

const TRAILING_COMMAS = `{
  // plugins I wrote myself
  "plugin": [
    "/home/user/.config/opencode/my-plugin.ts",
  ],

  "model": "ollama/some-model",
}
`;

const TRAILING_COMMAS_NO_PLUGIN = `{
  "provider": {
    "ollama": { "name": "Ollama (local)", },
  },
}
`;

describe('mergeOpencodePluginConfig — creating a config', () => {
  test('null existing → writes a config whose plugin array is exactly the path', () => {
    const content = writtenContent(mergeOpencodePluginConfig(null, PLUGIN_PATH));
    const parsed = JSON.parse(content) as { plugin: string[] };
    expect(parsed.plugin).toEqual([PLUGIN_PATH]);
  });

  test('works with a different plugin path (not hardcoded)', () => {
    const altPath = '/tmp/my-stop.ts';
    const content = writtenContent(mergeOpencodePluginConfig(null, altPath));
    expect((JSON.parse(content) as { plugin: string[] }).plugin).toEqual([altPath]);
  });
});

describe('mergeOpencodePluginConfig — editing JSONC in place', () => {
  test('issue #53 Case A: provider block, its // comment and the other plugin survive byte-for-byte', () => {
    const content = expectOnlyPluginAdded(CASE_A);
    expect(content).toContain('// this comment is legal JSONC and accepted by opencode');
    expect(content).toContain('"~/.umbel/hooks/opencode-stop.ts"');
  });

  test('/* block */ comments and blank lines survive when the plugin key is added', () => {
    const content = expectOnlyPluginAdded(BLOCK_COMMENT_NO_PLUGIN);
    expect(content).toContain('/* opencode config, hand-edited */');
    expect(content).toContain('/*\n   * Local models only.\n   */');
  });

  test('trailing commas and comments survive when appending to an existing plugin array', () => {
    expectOnlyPluginAdded(TRAILING_COMMAS);
  });

  test('trailing commas survive when the plugin key is added', () => {
    expectOnlyPluginAdded(TRAILING_COMMAS_NO_PLUGIN);
  });

  test('plain JSON with other keys: only the plugin entry is inserted', () => {
    const existing = JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        provider: { anthropic: { options: { apiKey: '{env:ANTHROPIC_API_KEY}' } } },
      },
      null,
      2,
    );
    expectOnlyPluginAdded(existing);
  });

  test('plain JSON with other plugins: appends without removing or reordering them', () => {
    const existing = JSON.stringify({ plugin: ['/a.ts', '/b.ts'] }, null, 2);
    expectOnlyPluginAdded(existing);
  });

  test('an empty plugin array gains the path', () => {
    expectOnlyPluginAdded('{\n  "plugin": []\n}\n');
  });
});

describe('mergeOpencodePluginConfig — already installed', () => {
  test('a file already listing the path comes back unchanged', () => {
    const existing = JSON.stringify({ plugin: [PLUGIN_PATH] }, null, 2);
    expect(mergeOpencodePluginConfig(existing, PLUGIN_PATH)).toEqual({ kind: 'unchanged' });
  });

  test('a commented file with trailing commas already listing the path comes back unchanged', () => {
    const existing = `{
  // keep
  "plugin": [
    "/other.ts",
    ${JSON.stringify(PLUGIN_PATH)},
  ],
}
`;
    expect(mergeOpencodePluginConfig(existing, PLUGIN_PATH)).toEqual({ kind: 'unchanged' });
  });

  test('merging the written result again is unchanged (idempotent)', () => {
    const first = writtenContent(mergeOpencodePluginConfig(CASE_A, PLUGIN_PATH));
    expect(mergeOpencodePluginConfig(first, PLUGIN_PATH)).toEqual({ kind: 'unchanged' });
    const created = writtenContent(mergeOpencodePluginConfig(null, PLUGIN_PATH));
    expect(mergeOpencodePluginConfig(created, PLUGIN_PATH)).toEqual({ kind: 'unchanged' });
  });
});

describe('mergeOpencodePluginConfig — unparsable input is reported, never replaced', () => {
  const cases: { name: string; text: string; line: number; column: number }[] = [
    {
      name: 'missing comma between properties',
      text: '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "a"\n  "provider": {}\n}\n',
      line: 4,
      column: 3,
    },
    {
      name: 'missing value',
      text: '{\n  // comment\n  "model": ,\n}\n',
      line: 3,
      column: 12,
    },
    {
      name: 'unterminated block comment',
      text: '{\n  "model": "a"\n  /* never closed\n}\n',
      line: 3,
      column: 3,
    },
  ];

  for (const c of cases) {
    test(`${c.name} → unparsable at line ${c.line}, column ${c.column}`, () => {
      const result = mergeOpencodePluginConfig(c.text, PLUGIN_PATH);
      expect(result.kind).toBe('unparsable');
      if (result.kind !== 'unparsable') return;
      expect(result.line).toBe(c.line);
      expect(result.column).toBe(c.column);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result).not.toHaveProperty('content');
    });
  }

  test('a root that is not an object is unparsable at its first token', () => {
    const result = mergeOpencodePluginConfig('\n  ["/a.ts"]\n', PLUGIN_PATH);
    expect(result).toMatchObject({ kind: 'unparsable', line: 2, column: 3 });
  });

  test('a plugin key that is not an array is unparsable at its value', () => {
    const result = mergeOpencodePluginConfig('{\n  "plugin": "/a.ts"\n}\n', PLUGIN_PATH);
    expect(result).toMatchObject({ kind: 'unparsable', line: 2, column: 13 });
  });
});
