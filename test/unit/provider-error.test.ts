import { describe, expect, test } from 'bun:test';
import { matchProviderError } from '../../src/core/idle.ts';

// The pane reader behind wait's provider-error: the newest of the pane's last
// fifteen non-empty lines that matches one of the provider's patterns, trimmed.

const patterns = [/unexpected status \d{3}/i, /API Error/];

describe('matchProviderError', () => {
  test('returns the matching line trimmed', () => {
    const pane = 'working\n  unexpected status 404 Not Found: no model  \n\n› \n\n';
    expect(matchProviderError(pane, patterns)).toBe('unexpected status 404 Not Found: no model');
  });

  test('prefers the newest matching line', () => {
    const pane = 'API Error: 500\nretrying\nAPI Error: 529 overloaded\n';
    expect(matchProviderError(pane, patterns)).toBe('API Error: 529 overloaded');
  });

  test('ignores a match that has scrolled above the last fifteen non-empty lines', () => {
    const later = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n\n');
    expect(matchProviderError(`API Error: 529\n${later}`, patterns)).toBeUndefined();
  });

  test('undefined without patterns or without a match', () => {
    expect(matchProviderError('API Error: 529', [])).toBeUndefined();
    expect(matchProviderError('all good\n', patterns)).toBeUndefined();
  });
});
