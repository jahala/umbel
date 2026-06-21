import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/adapters/exec.ts';

// exec.run is the real shell-exec primitive behind the opencode read path
// (resolve-transcript shells `opencode export` through it). Everywhere else
// injects a fake exec via deps, so these are the only tests that exercise the
// real Bun.spawn wrapper against the OS — no mocks. Each assertion is written
// to fail if the matching line in adapters/exec.ts regresses.

let tmpDir = '';

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('run', () => {
  test('returns the stdout of a successful command', async () => {
    expect(await run(['echo', 'hello'])).toBe('hello\n');
  });

  test('returns stdout only — never stderr — on success', async () => {
    const out = await run(['sh', '-c', 'echo out; echo err >&2']);
    expect(out).toBe('out\n');
    expect(out).not.toContain('err');
  });

  test('throws on a non-zero exit, with the exit code and stderr in the message', async () => {
    let caught: Error | undefined;
    try {
      await run(['sh', '-c', 'echo boom >&2; exit 3']);
    } catch (err) {
      caught = err as Error;
    }
    // A swallowed failure here would make a failed `opencode export` read as an
    // empty transcript instead of an error — the silent-failure class this guards.
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain('exit 3');
    expect(caught?.message).toContain('boom');
  });

  test('honors the cwd option', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-exec-test-'));
    await writeFile(join(tmpDir, 'marker.txt'), 'in-cwd');
    expect(await run(['cat', 'marker.txt'], { cwd: tmpDir })).toBe('in-cwd');
  });

  test('honors the env option (which replaces the environment, so PATH must be passed)', async () => {
    const out = await run(['sh', '-c', 'printf %s "$FOO"'], {
      env: { FOO: 'bar', PATH: process.env.PATH ?? '' },
    });
    expect(out).toBe('bar');
  });
});
