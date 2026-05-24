import { describe, expect, test } from 'bun:test';
import { unifiedDiff } from '../../src/core/diff.ts';

describe('unifiedDiff', () => {
  test('identical inputs → empty string', () => {
    expect(unifiedDiff('hello', 'hello')).toBe('');
    expect(unifiedDiff('a\nb\nc', 'a\nb\nc')).toBe('');
    expect(unifiedDiff('', '')).toBe('');
  });

  test('pure addition (empty → content) yields all +lines', () => {
    const out = unifiedDiff('', 'line1\nline2');
    expect(out).toContain('--- a/a');
    expect(out).toContain('+++ b/b');
    expect(out).toContain('+line1');
    expect(out).toContain('+line2');
    // Hunk uses -0,0 for empty side (matches `git diff /dev/null …`).
    expect(out).toContain('@@ -0,0 +1,2 @@');
    // No DEL diff lines (lines starting with - but not ---)
    const delLines = out.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    expect(delLines).toEqual([]);
  });

  test('pure deletion (content → empty) yields all -lines', () => {
    const out = unifiedDiff('line1\nline2', '');
    expect(out).toContain('-line1');
    expect(out).toContain('-line2');
    expect(out).toContain('@@ -1,2 +0,0 @@');
    const addLines = out.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(addLines).toEqual([]);
  });

  test('single-line change → hunk with context + change', () => {
    const a = 'one\ntwo\nthree\nfour\nfive';
    const b = 'one\ntwo\nTHREE\nfour\nfive';
    const out = unifiedDiff(a, b);
    expect(out).toContain('-three');
    expect(out).toContain('+THREE');
    // Surrounding context present (default contextLines=3)
    expect(out).toContain(' one');
    expect(out).toContain(' two');
    expect(out).toContain(' four');
    expect(out).toContain(' five');
  });

  test('label parameters appear in header', () => {
    const out = unifiedDiff('a', 'b', { aLabel: 'turn 0', bLabel: 'turn 1' });
    expect(out).toContain('--- a/turn 0');
    expect(out).toContain('+++ b/turn 1');
  });

  test('hunk header uses 1-indexed line numbers', () => {
    const out = unifiedDiff('only-a', 'only-b');
    // -1,1 +1,1 — both files have one line at line 1
    expect(out).toMatch(/@@ -1,1 \+1,1 @@/);
  });

  test('multi-hunk diff when changes are far apart', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    // Replace line 2 (idx 1) and line 18 (idx 17) — separated by enough
    // context lines that they should produce TWO hunks, not one.
    const bLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    bLines[1] = 'CHANGED-2';
    bLines[17] = 'CHANGED-18';
    const b = bLines.join('\n');
    const out = unifiedDiff(a, b);
    const hunkHeaders = out.match(/@@ /g) ?? [];
    expect(hunkHeaders.length).toBe(2);
    expect(out).toContain('-line 2');
    expect(out).toContain('+CHANGED-2');
    expect(out).toContain('-line 18');
    expect(out).toContain('+CHANGED-18');
  });

  test('adjacent changes merge into one hunk', () => {
    const a = 'one\ntwo\nthree';
    const b = 'one\n2\n3';
    const out = unifiedDiff(a, b);
    const hunkHeaders = out.match(/@@ /g) ?? [];
    expect(hunkHeaders.length).toBe(1);
    expect(out).toContain('-two');
    expect(out).toContain('-three');
    expect(out).toContain('+2');
    expect(out).toContain('+3');
  });

  test('custom contextLines: 0 emits no context', () => {
    const a = 'one\ntwo\nthree\nfour\nfive';
    const b = 'one\ntwo\nTHREE\nfour\nfive';
    const out = unifiedDiff(a, b, { contextLines: 0 });
    expect(out).toContain('-three');
    expect(out).toContain('+THREE');
    expect(out).not.toContain(' two');
    expect(out).not.toContain(' four');
  });

  test('completely different files yield interleaved del+add', () => {
    const out = unifiedDiff('a\nb\nc', 'x\ny\nz');
    expect(out).toContain('-a');
    expect(out).toContain('-b');
    expect(out).toContain('-c');
    expect(out).toContain('+x');
    expect(out).toContain('+y');
    expect(out).toContain('+z');
  });
});
