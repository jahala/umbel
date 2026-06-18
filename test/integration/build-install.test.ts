import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBinary } from '../../scripts/build.ts';

// installBinary must land an EXECUTABLE file via an atomic, fresh-inode replace,
// and re-installing OVER an existing binary must still yield a runnable file.
// (Replacing a code-signed binary in place on macOS invalidates the kernel's
// cached signature → the new file gets `Killed: 9`. That OS behaviour isn't
// portably testable; the runtime self-check in `build.ts --install` is the
// on-machine guard. These tests prove the mechanism: install lands a runnable
// executable, and the overwrite path stays runnable.)

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fakeBin(dir: string, word: string): Promise<string> {
  const path = join(dir, `src-${word}`);
  await writeFile(path, `#!/usr/bin/env bash\necho ${word}\n`, { mode: 0o755 });
  return path;
}

async function run(bin: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn([bin], { stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out: out.trim(), code };
}

describe('installBinary', () => {
  test('lands a runnable executable, creating the bin dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbel-install-'));
    created.push(dir);
    const dest = join(dir, 'bin', 'umbel'); // nested dir must be created
    await installBinary(await fakeBin(dir, 'ok'), dest);
    expect(await run(dest)).toEqual({ out: 'ok', code: 0 });
  });

  test('re-installing over an existing binary stays runnable (fresh inode, not in-place)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'umbel-install-'));
    created.push(dir);
    const dest = join(dir, 'bin', 'umbel');
    await installBinary(await fakeBin(dir, 'v1'), dest);
    await installBinary(await fakeBin(dir, 'v2'), dest); // overwrite — the macOS-kill scenario
    expect(await run(dest)).toEqual({ out: 'v2', code: 0 });
  });
});
