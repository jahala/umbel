import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePane, hasSession, TMUX_CALL_TIMEOUT_MS } from '../../src/adapters/tmux.ts';
import { TmuxError } from '../../src/core/errors.ts';

// ---------------------------------------------------------------------------
// umbel#98: every deadline umbel keeps is evaluated between tmux calls, and a
// tmux call had no bound of its own. A client that never answers held a wait
// past its timeout, and the poll behind it kept starting more. A call that goes
// unanswered is ended and reported.
// ---------------------------------------------------------------------------

let binDir = '';
let realPath = '';

afterEach(async () => {
  if (realPath !== '') {
    process.env.PATH = realPath;
    realPath = '';
  }
  if (binDir !== '') {
    await rm(binDir, { recursive: true, force: true });
    binDir = '';
  }
});

// A tmux that accepts any command and never answers.
async function silentTmux(): Promise<void> {
  binDir = await mkdtemp(join(tmpdir(), 'umbel-tmux-silent-'));
  const fake = join(binDir, 'tmux');
  await writeFile(fake, '#!/usr/bin/env bash\nsleep 600\n');
  await chmod(fake, 0o755);
  realPath = process.env.PATH ?? '';
  process.env.PATH = `${binDir}:${realPath}`;
}

describe('a tmux call that goes unanswered', () => {
  test('ends at its bound and says so', async () => {
    await silentTmux();
    const started = Date.now();

    const err = await capturePane('nobody', 5, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TmuxError);
    expect((err as TmuxError).message).toContain('did not answer');
    expect(Date.now() - started).toBeLessThan(TMUX_CALL_TIMEOUT_MS + 3_000);
  }, 30_000);

  test('is not read as a session that does not exist', async () => {
    await silentTmux();

    // A silent tmux says nothing about the session. Reporting "no such session"
    // here would turn an unresponsive server into a worker declared gone.
    await expect(hasSession('nobody', {})).rejects.toThrow(TmuxError);
  }, 30_000);
});
