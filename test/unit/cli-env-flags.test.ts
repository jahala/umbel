import { describe, expect, test } from 'bun:test';
import { UmbelUsageError } from '../../src/core/errors.ts';
import { WorkerSpecSchema } from '../../src/core/types.ts';
import { parseEnvFlags } from '../../src/faces/cli.ts';
import { VerbSchemas } from '../../src/faces/verbs.ts';

// ---------------------------------------------------------------------------
// parseEnvFlags — turns repeated `--env KEY=VALUE` flags into an override map.
// The throw-on-malformed cases matter: a bad --env must fail loudly, never be
// silently dropped (which is the exact class of bug the env passthrough fixes).
// ---------------------------------------------------------------------------

describe('parseEnvFlags', () => {
  test('parses a single KEY=VALUE entry', () => {
    expect(parseEnvFlags(['FOO=bar'])).toEqual({ FOO: 'bar' });
  });

  test('merges multiple entries (repeatable --env)', () => {
    expect(parseEnvFlags(['FOO=bar', 'HTTPS_PROXY=http://p:8080'])).toEqual({
      FOO: 'bar',
      HTTPS_PROXY: 'http://p:8080',
    });
  });

  test('splits on the FIRST = so values may contain =', () => {
    expect(parseEnvFlags(['TOKEN=a=b=c'])).toEqual({ TOKEN: 'a=b=c' });
  });

  test('allows an empty value', () => {
    expect(parseEnvFlags(['EMPTY='])).toEqual({ EMPTY: '' });
  });

  test('throws UmbelUsageError on a missing = (no silent drop)', () => {
    expect(() => parseEnvFlags(['NOEQUALS'])).toThrow(UmbelUsageError);
  });

  test('throws UmbelUsageError on an empty key', () => {
    expect(() => parseEnvFlags(['=value'])).toThrow(UmbelUsageError);
  });
});

// ---------------------------------------------------------------------------
// env wired into the shared schemas — same definition reused across the MCP
// tool input (VerbSchemas.spawn) and workflow YAML (WorkerSpecSchema).
// ---------------------------------------------------------------------------

describe('env field wired into shared schemas', () => {
  test('VerbSchemas.spawn accepts an env record (CLI + MCP surface)', () => {
    const parsed = VerbSchemas.spawn.parse({ cwd: '.', env: { FOO: 'bar' } });
    expect(parsed.env).toEqual({ FOO: 'bar' });
  });

  test('VerbSchemas.spawn env is optional', () => {
    const parsed = VerbSchemas.spawn.parse({ cwd: '.' });
    expect(parsed.env).toBeUndefined();
  });

  test('WorkerSpecSchema accepts a per-worker env map (workflow surface)', () => {
    const parsed = WorkerSpecSchema.parse({ cwd: '.', env: { FOO: 'bar' } });
    expect(parsed.env).toEqual({ FOO: 'bar' });
  });
});
