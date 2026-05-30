import { describe, expect, test } from 'bun:test';
import { ProviderUnknownError } from '../../../src/core/errors.ts';
import { getProvider, PROVIDERS } from '../../../src/core/providers/registry.ts';

describe('getProvider', () => {
  test('returns the registered provider for a known name', () => {
    expect(getProvider('claude').name).toBe('claude');
    expect(getProvider('opencode').name).toBe('opencode');
  });

  test('throws ProviderUnknownError for an unknown provider', () => {
    expect(() => getProvider('bogus')).toThrow(ProviderUnknownError);
  });

  // The CLI maps this to exit 2 and prints the message; the cli-reference
  // promises it "lists valid providers", so the message must actually do so.
  test('the error message names the bad provider AND lists every valid one', () => {
    let msg = '';
    try {
      getProvider('bogus');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('bogus');
    for (const name of Object.keys(PROVIDERS)) {
      expect(msg).toContain(name);
    }
  });
});
