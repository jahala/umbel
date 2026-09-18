import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketFor } from '../../src/adapters/tmux.ts';
import { runCli } from '../../src/faces/cli.ts';

// ---------------------------------------------------------------------------
// `umbel attach` started tmux with no socket, so it looked on the default one,
// where no worker has lived since workers moved to a private socket. Every
// attach answered that the session did not exist.
// ---------------------------------------------------------------------------

let dir = '';
const saved = { PATH: process.env.PATH, UMBEL_STATE: process.env.UMBEL_STATE };

afterEach(async () => {
  process.env.PATH = saved.PATH;
  if (saved.UMBEL_STATE === undefined) delete process.env.UMBEL_STATE;
  else process.env.UMBEL_STATE = saved.UMBEL_STATE;
  if (dir !== '') {
    await rm(dir, { recursive: true, force: true });
    dir = '';
  }
});

describe('umbel attach', () => {
  test("reaches the worker on its state root's socket", async () => {
    dir = await mkdtemp(join(tmpdir(), 'umbel-attach-'));
    const record = join(dir, 'argv');
    // A tmux that writes down how it was called, then exits.
    const fake = join(dir, 'tmux');
    await writeFile(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${record}'\n`);
    await chmod(fake, 0o755);
    process.env.PATH = `${dir}:${saved.PATH ?? ''}`;
    process.env.UMBEL_STATE = join(dir, 'state');

    const code = await runCli(['attach', 'w1']);

    expect(code).toBe(0);
    const argv = (await readFile(record, 'utf8')).trim().split('\n');
    expect(argv).toEqual([
      '-L',
      socketFor({ UMBEL_STATE: process.env.UMBEL_STATE }),
      'attach',
      '-t',
      'umbel-w1',
    ]);
  });
});
