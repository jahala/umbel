import { describe, expect, test } from 'bun:test';
import { truncateAssistantText } from '../../src/core/truncate.ts';

// ~4 chars per token approximation. The default 2000-token cap == 8000 chars.

describe('truncateAssistantText — no opts (default truncation)', () => {
  test('short text returned unchanged', () => {
    const short = 'hello world\nsecond line\nthird line';
    expect(truncateAssistantText(short)).toBe(short);
  });

  test('text at default cap (8000 chars) returned unchanged', () => {
    const text = 'a'.repeat(8000);
    expect(truncateAssistantText(text)).toBe(text);
  });

  test('long text (>2000 tokens) returns head+elision+tail', () => {
    // 100 lines × ~150 chars each = 15000 chars ≈ 3750 tokens
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(140)}`);
    const text = lines.join('\n');
    const out = truncateAssistantText(text);
    expect(out).not.toBe(text);
    expect(out).toContain('elided');
    expect(out).toContain('call umbel_read with full=true');
    // First line preserved
    expect(out).toContain('line 0:');
    // Last line preserved
    expect(out).toContain('line 99:');
    // Some middle line dropped
    expect(out).not.toContain('line 50:');
  });
});

describe('truncateAssistantText — full=true bypasses everything', () => {
  test('long text returned in full', () => {
    const text = 'x'.repeat(20000);
    expect(truncateAssistantText(text, { full: true })).toBe(text);
  });

  test('full=true wins even with head/tail set', () => {
    const text = 'long text here';
    expect(truncateAssistantText(text, { full: true, head: 1, tail: 1 })).toBe(text);
  });
});

describe('truncateAssistantText — head', () => {
  test('head=10 keeps roughly first 40 chars, snapped to line boundary', () => {
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}\n${'c'.repeat(30)}`;
    const out = truncateAssistantText(text, { head: 10 });
    // First line included (30 chars ≤ 40-char budget)
    expect(out.startsWith('a'.repeat(30))).toBe(true);
    // 'b' line not included (would exceed budget at 30+1+30=61 chars)
    expect(out).not.toContain('b'.repeat(30));
  });

  test('head=0 returns empty', () => {
    const out = truncateAssistantText('x'.repeat(1000), { head: 0 });
    expect(out).toBe('');
  });

  test('head larger than text returns whole text', () => {
    const text = 'short';
    expect(truncateAssistantText(text, { head: 9999 })).toBe(text);
  });
});

describe('truncateAssistantText — tail', () => {
  test('tail=10 keeps last lines under ~40 chars, snapped to line boundary', () => {
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}\n${'c'.repeat(30)}`;
    const out = truncateAssistantText(text, { tail: 10 });
    // Last line included
    expect(out.endsWith('c'.repeat(30))).toBe(true);
    // First line not included
    expect(out).not.toContain('a'.repeat(30));
  });

  test('tail larger than text returns whole text', () => {
    const text = 'short';
    expect(truncateAssistantText(text, { tail: 9999 })).toBe(text);
  });
});

describe('truncateAssistantText — section', () => {
  const md = `Intro paragraph

## Findings

- Issue A
- Issue B

## Recommendations

- Fix C
- Fix D

## Notes

end of document`;

  test('exact heading match returns that section only', () => {
    const out = truncateAssistantText(md, { section: '## Findings' });
    expect(out).toContain('## Findings');
    expect(out).toContain('Issue A');
    expect(out).toContain('Issue B');
    expect(out).not.toContain('## Recommendations');
    expect(out).not.toContain('Fix C');
  });

  test('section continues until next same-or-higher-level heading', () => {
    const out = truncateAssistantText(md, { section: '## Recommendations' });
    expect(out).toContain('Fix C');
    expect(out).toContain('Fix D');
    expect(out).not.toContain('## Notes');
  });

  test('missing heading returns empty string', () => {
    const out = truncateAssistantText(md, { section: '## Missing' });
    expect(out).toBe('');
  });

  test('lower-level subheading does NOT terminate section', () => {
    const text = `## A

para 1

### Sub

para 2

## B

para 3`;
    const out = truncateAssistantText(text, { section: '## A' });
    expect(out).toContain('para 1');
    expect(out).toContain('### Sub');
    expect(out).toContain('para 2');
    expect(out).not.toContain('## B');
    expect(out).not.toContain('para 3');
  });
});

describe('truncateAssistantText — head + tail combined', () => {
  test('both set → head + elision + tail', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const text = lines.join('\n');
    const out = truncateAssistantText(text, { head: 5, tail: 5 });
    expect(out).toContain('line 0');
    expect(out).toContain('line 49');
    expect(out).toContain('elided');
  });
});
