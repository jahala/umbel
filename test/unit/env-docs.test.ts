import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

// The environment table in docs/cli-reference.md: one row per variable.
function documentedNames(): string[] {
  const doc = readFileSync(join(ROOT, 'docs', 'cli-reference.md'), 'utf8');
  const start = doc.indexOf('## Environment variables');
  expect(start).toBeGreaterThanOrEqual(0);
  const section = doc.slice(start);
  return [...section.matchAll(/^\| `(UMBEL_[A-Z0-9_]+)` \|/gm)].flatMap((match) =>
    match[1] !== undefined ? [match[1]] : [],
  );
}

// Every UMBEL_* name src reads from an environment object.
function readNames(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:process\.env|env)\??\.(UMBEL_[A-Z0-9_]+)/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe('docs/cli-reference.md environment table', () => {
  test('every variable it lists is read in src', () => {
    const read = new Set(readNames());
    expect(documentedNames().filter((name) => !read.has(name))).toEqual([]);
  });

  test('every UMBEL_* variable src reads is listed', () => {
    const documented = new Set(documentedNames());
    expect(readNames().filter((name) => !documented.has(name))).toEqual([]);
  });
});
