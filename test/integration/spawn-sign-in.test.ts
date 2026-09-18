import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession, paneState } from '../../src/adapters/tmux.ts';
import { ProviderNotSignedInError } from '../../src/core/errors.ts';
import { spawn } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// umbel#105: a worker whose CLI opened on its sign-in screen was reported
// spawned, and every wait on it ran to its deadline. It is refused at spawn,
// with the screen's line, and leaves nothing behind.
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('spawn: a CLI at its sign-in screen', () => {
  test('is refused, naming the line, and leaves no session behind', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-sign-in-'));
    const env = { UMBEL_STATE: tmpDir };
    const name = `t${RUN_ID}signin`;
    const projects = join(tmpDir, 'projects');

    const err = await spawn({
      name,
      cwd: '/tmp',
      claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
      env: {
        ...env,
        FAKE_CLAUDE_SIGN_IN: join(import.meta.dir, '../fixtures/sign-in/claude-2.1.276-login.txt'),
      },
      deps: {
        jsonl: {
          ...jsonlAdapter,
          discoverSessionJsonl: (o) =>
            jsonlAdapter.discoverSessionJsonl({ ...o, projectsRoot: projects }),
        },
      },
    }).catch((e: unknown) => e);

    await killSession(name, env).catch(() => undefined);
    expect(err).toBeInstanceOf(ProviderNotSignedInError);
    expect((err as Error).message).toContain('Select login method:');
    expect((await paneState(name, env)).exists).toBe(false);
    expect(existsSync(join(tmpDir, 'sessions', name))).toBe(false);
  }, 30_000);
});
