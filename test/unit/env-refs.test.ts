import { describe, expect, test } from 'bun:test';
import { resolveEnvRefs } from '../../src/core/env.ts';
import { EnvRefUnresolvedError } from '../../src/core/errors.ts';
import { EnvValueSchema } from '../../src/core/types.ts';

// resolveEnvRefs turns a worker-env spec (literals + {fromEnv} references) into a
// flat string env, resolving references against a source env (the umbel server's
// process.env at the call site). Passing a reference instead of a literal keeps
// the secret out of the caller's tool-call transcript.

describe('resolveEnvRefs', () => {
  test('passes literal string values through unchanged', () => {
    expect(resolveEnvRefs({ A: 'x', B: 'y' }, {})).toEqual({ A: 'x', B: 'y' });
  });

  test('resolves a {fromEnv} reference from the source env', () => {
    const out = resolveEnvRefs(
      { ANTHROPIC_AUTH_TOKEN: { fromEnv: 'DEEPSEEK_API_KEY' } },
      { DEEPSEEK_API_KEY: 'sk-secret' },
    );
    expect(out).toEqual({ ANTHROPIC_AUTH_TOKEN: 'sk-secret' });
  });

  test('mixes literals and references', () => {
    const out = resolveEnvRefs(
      { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', TOKEN: { fromEnv: 'SRC' } },
      { SRC: 'val' },
    );
    expect(out).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      TOKEN: 'val',
    });
  });

  test('throws EnvRefUnresolvedError when the source var is unset', () => {
    expect(() => resolveEnvRefs({ TOKEN: { fromEnv: 'MISSING' } }, {})).toThrow(
      EnvRefUnresolvedError,
    );
  });

  test('the error names both the target key and the missing source var', () => {
    let err: unknown;
    try {
      resolveEnvRefs({ TOKEN: { fromEnv: 'MISSING_SRC' } }, {});
    } catch (e) {
      err = e;
    }
    expect(err instanceof EnvRefUnresolvedError).toBe(true);
    expect((err as EnvRefUnresolvedError).key).toBe('TOKEN');
    expect((err as EnvRefUnresolvedError).sourceVar).toBe('MISSING_SRC');
  });

  test('empty spec resolves to empty', () => {
    expect(resolveEnvRefs({}, { FOO: 'bar' })).toEqual({});
  });
});

describe('EnvValueSchema', () => {
  test('accepts a literal string', () => {
    expect(EnvValueSchema.parse('literal')).toBe('literal');
  });

  test('accepts a {fromEnv} reference', () => {
    expect(EnvValueSchema.parse({ fromEnv: 'SRC' })).toEqual({ fromEnv: 'SRC' });
  });

  test('rejects a malformed reference object', () => {
    expect(() => EnvValueSchema.parse({ from: 'SRC' })).toThrow();
    expect(() => EnvValueSchema.parse({ fromEnv: 'SRC', extra: 'x' })).toThrow();
  });
});
