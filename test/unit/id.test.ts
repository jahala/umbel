import { describe, expect, test } from 'bun:test';
import { generateSessionName, isValidSessionName } from '../../src/core/id.ts';

describe('generateSessionName', () => {
  test('default format matches anon-XXXXXX', () => {
    const name = generateSessionName();
    expect(name).toMatch(/^anon-[a-z0-9]{6}$/);
  });

  test('prefix format matches prefix-XXXXXX', () => {
    const name = generateSessionName('proj');
    expect(name).toMatch(/^proj-[a-z0-9]{6}$/);
  });

  test('deterministic given a seed RNG', () => {
    const rng = () => 0.5;
    const first = generateSessionName(undefined, rng);
    const second = generateSessionName(undefined, rng);
    expect(first).toBe(second);
  });

  test('different RNG values produce different suffixes', () => {
    let counter = 0;
    const rng1 = () => (counter++ % 36) / 36;
    let counter2 = 10;
    const rng2 = () => (counter2++ % 36) / 36;
    const first = generateSessionName(undefined, rng1);
    const second = generateSessionName(undefined, rng2);
    expect(first).not.toBe(second);
  });

  test('suffix is exactly 6 base36 characters', () => {
    const name = generateSessionName('test');
    const suffix = name.slice('test-'.length);
    expect(suffix).toHaveLength(6);
    expect(suffix).toMatch(/^[a-z0-9]{6}$/);
  });

  test('generated name passes isValidSessionName', () => {
    const name = generateSessionName();
    expect(isValidSessionName(name)).toBe(true);
  });

  test('generated name with prefix passes isValidSessionName', () => {
    const name = generateSessionName('worker');
    expect(isValidSessionName(name)).toBe(true);
  });
});

describe('isValidSessionName', () => {
  test('accepts simple alphanumeric', () => {
    expect(isValidSessionName('abc123')).toBe(true);
  });

  test('accepts names with dashes', () => {
    expect(isValidSessionName('foo-bar-baz')).toBe(true);
  });

  test('accepts single character', () => {
    expect(isValidSessionName('a')).toBe(true);
  });

  test('accepts 63-character name (max)', () => {
    const name = `a${'b'.repeat(62)}`;
    expect(name).toHaveLength(63);
    expect(isValidSessionName(name)).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isValidSessionName('')).toBe(false);
  });

  test('rejects leading dash', () => {
    expect(isValidSessionName('-foo')).toBe(false);
  });

  test('rejects uppercase letters', () => {
    expect(isValidSessionName('FooBar')).toBe(false);
  });

  test('rejects name longer than 63 chars', () => {
    const name = 'a'.repeat(64);
    expect(isValidSessionName(name)).toBe(false);
  });

  test('rejects dots', () => {
    expect(isValidSessionName('foo.bar')).toBe(false);
  });

  test('rejects slashes', () => {
    expect(isValidSessionName('foo/bar')).toBe(false);
  });

  test('rejects spaces', () => {
    expect(isValidSessionName('foo bar')).toBe(false);
  });

  test('rejects underscore', () => {
    expect(isValidSessionName('foo_bar')).toBe(false);
  });

  test('accepts anon-XXXXXX pattern', () => {
    expect(isValidSessionName('anon-a1b2c3')).toBe(true);
  });
});
