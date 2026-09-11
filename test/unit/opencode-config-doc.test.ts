import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpForTopic } from '../../src/faces/mcp-help.ts';

const root = join(import.meta.dir, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const paragraphsMentioning = (text: string, needle: string): string =>
  text
    .split(/\n\s*\n/)
    .filter((p) => p.includes(needle))
    .join('\n\n');

const opencodeHelpBlock = (): string => {
  const text = helpForTopic('providers');
  const start = text.indexOf('OpenCode (`provider: opencode`)');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n\n', start);
  return text.slice(start, end === -1 ? undefined : end);
};

describe('opencode config contract is documented', () => {
  test('docs/cli-reference.md states the opencode.jsonc read, in-place edit and refusal', () => {
    const notes = paragraphsMentioning(read('docs/cli-reference.md'), 'opencode.jsonc');
    expect(notes).toContain('JSONC');
    expect(notes).toMatch(/preserv/i);
    expect(notes).toMatch(/comments/i);
    expect(notes).toMatch(/unparsable|does not parse|cannot be parsed/i);
    expect(notes).toContain('exit 1');
  });

  test('docs/cli-reference.md spawn --model row states the opencode models check and exit 2', () => {
    const doc = read('docs/cli-reference.md');
    const start = doc.indexOf('\n### spawn\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const spawnSection = doc.slice(start, doc.indexOf('\n### ', start + 1));
    const modelRow = spawnSection.split('\n').find((line) => line.startsWith('| `--model MODEL`'));
    expect(modelRow).toBeDefined();
    expect(modelRow).toContain('opencode models');
    expect(modelRow).toContain('exit 2');
  });

  test('the providers help topic states the contract instead of "crash-safe, reversible"', () => {
    const block = opencodeHelpBlock();
    expect(block).not.toContain('crash-safe, reversible');
    expect(block).toContain('opencode.jsonc');
    expect(block).toContain('JSONC');
    expect(block).toMatch(/preserv/i);
    expect(block).toMatch(/comments/i);
    expect(block).toContain('exit 1');
    expect(block).toContain('opencode models');
    expect(block).toContain('exit 2');
  });

  test("CLAUDE.md's Stack line lists jsonc-parser", () => {
    const deps = read('CLAUDE.md')
      .split('\n')
      .find((line) => line.startsWith('- Dependencies:'));
    expect(deps).toContain('`jsonc-parser`');
  });
});
