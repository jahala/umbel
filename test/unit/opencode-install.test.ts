import { describe, expect, test } from 'bun:test';
import { removeUmbelPluginEntries } from '../../src/core/providers/opencode.ts';

// ---------------------------------------------------------------------------
// removeUmbelPluginEntries
//
// Old umbels wrote the plugin under <UMBEL_STATE>/hooks and registered its path
// in the user's opencode.jsonc, so every state root left an entry behind
// (umbel#124). The plugin now loads from the config dir, and this function
// removes the entries an older umbel added. Contract:
//   - null / empty / no "plugin" key / no legacy entry -> { kind: 'unchanged' }
//   - legacy entry present  -> { kind: 'write', content } where only the legacy
//                              entries and their separators are gone; every
//                              other byte, comment and trailing comma survives
//   - text that is not JSONC -> { kind: 'unparsable', line, column, reason }
// JSONC semantics are checked with Bun.JSONC, independent of the implementation.
// ---------------------------------------------------------------------------

const LEGACY_A = '/tmp/umbel-review116.abc/hooks/opencode-stop.ts';
const LEGACY_B = '/home/user/.umbel/hooks/opencode-stop.ts';
const USER_PLUGIN = '/home/user/.config/opencode/my-plugin.ts';

type JsonObj = Record<string, unknown>;

function writtenContent(result: ReturnType<typeof removeUmbelPluginEntries>): string {
  expect(result.kind).toBe('write');
  if (result.kind !== 'write') throw new Error(`expected write, got ${result.kind}`);
  return result.content;
}

// Asserts every line of `before` that does not carry a legacy entry survives in
// order. A trailing comma may disappear when the removed entry was the last
// element: that comma is the separator the removal has to take with it.
function expectOtherLinesKept(before: string, after: string, legacy: string[]): void {
  const strip = (line: string): string => line.replace(/,\s*$/, '');
  const kept = before
    .split('\n')
    .filter((line) => !legacy.some((p) => line.includes(p)))
    .map(strip);
  const target = after.split('\n').map(strip).join('\n');
  let from = 0;
  for (const line of kept) {
    const at = target.indexOf(line, from);
    expect(at).toBeGreaterThanOrEqual(from);
    from = at + line.length;
  }
}

const TWO_LEGACY = `{
  "$schema": "https://opencode.ai/config.json",
  // two throwaway state roots left these behind (umbel#124)
  "plugin": [
    "${LEGACY_A}",
    "${USER_PLUGIN}",
    "${LEGACY_B}",
  ],
  "provider": {
    "ollama": { "options": { "baseURL": "http://localhost:11434/v1" } },
  },
}
`;

describe('removeUmbelPluginEntries — nothing to remove', () => {
  test('a missing config comes back unchanged', () => {
    expect(removeUmbelPluginEntries(null)).toEqual({ kind: 'unchanged' });
  });

  test('an empty config comes back unchanged', () => {
    expect(removeUmbelPluginEntries('   \n')).toEqual({ kind: 'unchanged' });
  });

  test('a config with no plugin key comes back unchanged', () => {
    expect(removeUmbelPluginEntries('{\n  "model": "ollama/some-model"\n}\n')).toEqual({
      kind: 'unchanged',
    });
  });

  test("a config listing only the user's own plugins comes back unchanged", () => {
    const existing = `{
  // mine
  "plugin": [
    "${USER_PLUGIN}",
  ],
}
`;
    expect(removeUmbelPluginEntries(existing)).toEqual({ kind: 'unchanged' });
  });

  test('a user plugin merely named opencode-stop.ts outside a hooks dir is kept', () => {
    const existing = JSON.stringify({ plugin: ['/home/user/plugins/opencode-stop.ts'] }, null, 2);
    expect(removeUmbelPluginEntries(existing)).toEqual({ kind: 'unchanged' });
  });
});

describe('removeUmbelPluginEntries — removing what an older umbel added', () => {
  test("two legacy entries go and the user's plugin, comments and layout stay", () => {
    const content = writtenContent(removeUmbelPluginEntries(TWO_LEGACY));

    expect(content).not.toContain(LEGACY_A);
    expect(content).not.toContain(LEGACY_B);
    expect(content).toContain('// two throwaway state roots left these behind (umbel#124)');
    expect(content).toContain(USER_PLUGIN);
    expectOtherLinesKept(TWO_LEGACY, content, [LEGACY_A, LEGACY_B]);

    const before = Bun.JSONC.parse(TWO_LEGACY) as JsonObj;
    const after = Bun.JSONC.parse(content) as JsonObj;
    expect(after.plugin).toEqual([USER_PLUGIN]);
    const { plugin: _b, ...restBefore } = before;
    const { plugin: _a, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
  });

  test('the `~/.umbel` form the old installer wrote is removed', () => {
    const existing = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["~/.umbel/hooks/opencode-stop.ts"],
}
`;
    const content = writtenContent(removeUmbelPluginEntries(existing));
    expect((Bun.JSONC.parse(content) as JsonObj).plugin).toEqual([]);
  });

  test('a plugin key that no longer has entries is left in place, not dropped', () => {
    const existing = '{\n  "plugin": ["~/.umbel/hooks/opencode-stop.ts"]\n}\n';
    const content = writtenContent(removeUmbelPluginEntries(existing));
    expect(content).toBe('{\n  "plugin": []\n}\n');
  });

  test('an inline plugin array loses only the legacy entry', () => {
    const existing = `{
  "plugin": ["${LEGACY_A}", "${USER_PLUGIN}"]
}
`;
    const content = writtenContent(removeUmbelPluginEntries(existing));
    expect(content).toContain(`"plugin": ["${USER_PLUGIN}"]`);
    expect((Bun.JSONC.parse(content) as JsonObj).plugin).toEqual([USER_PLUGIN]);
  });

  test('a legacy entry on the last inline slot leaves the others intact', () => {
    const existing = `{
  "plugin": ["${USER_PLUGIN}", "${LEGACY_B}"]
}
`;
    const content = writtenContent(removeUmbelPluginEntries(existing));
    expect((Bun.JSONC.parse(content) as JsonObj).plugin).toEqual([USER_PLUGIN]);
  });

  test('a single-element array becomes empty', () => {
    const existing = `{
  "plugin": [
    "${LEGACY_B}",
  ],
  "model": "ollama/some-model",
}
`;
    const content = writtenContent(removeUmbelPluginEntries(existing));
    expect((Bun.JSONC.parse(content) as JsonObj).plugin).toEqual([]);
    expect(content).toContain('"model": "ollama/some-model"');
  });

  test('Windows path separators are recognised', () => {
    const existing =
      '{\n  "plugin": ["C:\\\\Users\\\\me\\\\.umbel\\\\hooks\\\\opencode-stop.ts"]\n}\n';
    const content = writtenContent(removeUmbelPluginEntries(existing));
    expect((Bun.JSONC.parse(content) as JsonObj).plugin).toEqual([]);
  });

  test('a relative hooks path is recognised', () => {
    const existing = '{\n  "plugin": ["hooks/opencode-stop.ts"]\n}\n';
    const content = writtenContent(removeUmbelPluginEntries(existing));
    expect((Bun.JSONC.parse(content) as JsonObj).plugin).toEqual([]);
  });

  test('removing again comes back unchanged (idempotent)', () => {
    const content = writtenContent(removeUmbelPluginEntries(TWO_LEGACY));
    expect(removeUmbelPluginEntries(content)).toEqual({ kind: 'unchanged' });
  });
});

describe('removeUmbelPluginEntries — unparsable input is reported, never replaced', () => {
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
      const result = removeUmbelPluginEntries(c.text);
      expect(result.kind).toBe('unparsable');
      if (result.kind !== 'unparsable') return;
      expect(result.line).toBe(c.line);
      expect(result.column).toBe(c.column);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result).not.toHaveProperty('content');
    });
  }

  test('a root that is not an object is unparsable at its first token', () => {
    const result = removeUmbelPluginEntries('\n  ["/a.ts"]\n');
    expect(result).toMatchObject({ kind: 'unparsable', line: 2, column: 3 });
  });

  test('a plugin key that is not an array is unparsable at its value', () => {
    const result = removeUmbelPluginEntries('{\n  "plugin": "/a.ts"\n}\n');
    expect(result).toMatchObject({ kind: 'unparsable', line: 2, column: 13 });
  });
});
