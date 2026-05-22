import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchEvent } from '../../src/adapters/fs-watch.ts';
import { watch } from '../../src/adapters/fs-watch.ts';

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

async function setup(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-fs-watch-test-'));
  return tmpDir;
}

async function collectEvents(
  iter: AsyncIterable<WatchEvent>,
  count: number,
  timeoutMs = 5000,
): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  const iterator = iter[Symbol.asyncIterator]();
  while (events.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    type Result = IteratorResult<WatchEvent, undefined>;
    const timeout = new Promise<Result>((resolve) => {
      setTimeout(() => resolve({ done: true, value: undefined }), remaining);
    });
    const result = await Promise.race([iterator.next(), timeout]);
    if (result.done) break;
    events.push(result.value);
  }
  return events;
}

describe('watch', () => {
  test('detects file creation in watched dir', async () => {
    const dir = await setup();
    const controller = new AbortController();

    const filePath = join(dir, 'new-file.txt');
    const iter = watch([dir], controller.signal);

    // Trigger creation after watcher is set up
    await Bun.sleep(200);
    await writeFile(filePath, 'hello');

    const events = await collectEvents(iter, 1, 4000);
    controller.abort();

    const matchingEvent = events.find(
      (e) => e.path === filePath && (e.kind === 'add' || e.kind === 'change'),
    );
    expect(matchingEvent).toBeDefined();
  });

  test('detects file modification', async () => {
    const dir = await setup();
    const filePath = join(dir, 'existing.txt');
    await writeFile(filePath, 'initial content');

    const controller = new AbortController();
    const iter = watch([filePath], controller.signal);

    await Bun.sleep(200);
    await writeFile(filePath, 'modified content');

    const events = await collectEvents(iter, 2, 4000);
    controller.abort();

    const changeEvent = events.find(
      (e) => (e.kind === 'change' || e.kind === 'add') && e.path === filePath,
    );
    expect(changeEvent).toBeDefined();
  });

  test('abort signal stops the iterator', async () => {
    const dir = await setup();
    const controller = new AbortController();
    const iter = watch([dir], controller.signal);

    let completed = false;
    const drainPromise = (async () => {
      for await (const _ of iter) {
        // drain events until done
      }
      completed = true;
    })();

    controller.abort();
    await Bun.sleep(500);
    await drainPromise;

    expect(completed).toBe(true);
  });

  test('watches multiple paths in one call', async () => {
    const dir = await setup();
    const fileA = join(dir, 'a.txt');
    const fileB = join(dir, 'b.txt');

    const controller = new AbortController();
    const iter = watch([fileA, fileB], controller.signal);

    await Bun.sleep(200);
    await writeFile(fileA, 'a content');
    await writeFile(fileB, 'b content');

    const events = await collectEvents(iter, 3, 4000);
    controller.abort();

    const paths = new Set(events.map((e) => e.path));
    expect(paths.has(fileA) || paths.has(fileB)).toBe(true);
  });

  test('no handle leak — watcher is closed on abort', async () => {
    const dir = await setup();
    const controller = new AbortController();
    const iter = watch([dir], controller.signal);

    // Start draining
    const drainPromise = (async () => {
      for await (const _ of iter) {
        // drain events until done
      }
    })();

    await Bun.sleep(100);
    controller.abort();
    // Should resolve cleanly (no hang)
    await Promise.race([
      drainPromise,
      Bun.sleep(2000).then(() => Promise.reject(new Error('timeout'))),
    ]);
  });

  // Line 33: classify catch path — non-existent path treated as 'file' (fs.watchFile)
  // Verifies that a non-existent path fires 'add' when the file is created
  test('non-existent path watched as file; creation fires add event', async () => {
    const dir = await setup();
    const nonExistentFile = join(dir, 'not-yet-created.txt');
    const controller = new AbortController();

    // Watch a path that does not exist — classify() catches statSync and returns 'file'
    const iter = watch([nonExistentFile], controller.signal);

    // Give watcher time to set up, then create the file
    await Bun.sleep(200);
    await writeFile(nonExistentFile, 'hello');

    const events = await collectEvents(iter, 1, 4000);
    controller.abort();

    const addEvent = events.find((e) => e.path === nonExistentFile && e.kind === 'add');
    expect(addEvent).toBeDefined();
  });

  // Lines 100-110: fs.watchFile listener — existing file deleted fires 'unlink'
  test('file deletion fires unlink event on watched file', async () => {
    const dir = await setup();
    const filePath = join(dir, 'to-delete.txt');
    await writeFile(filePath, 'initial');

    const controller = new AbortController();
    // Watching a file path uses the fs.watchFile code path.
    // IMPORTANT: start collecting BEFORE sleeping/deleting so the watcher is set up
    // (Symbol.asyncIterator is called lazily inside collectEvents) while the file exists.
    const iter = watch([filePath], controller.signal);

    // Start collection immediately — this calls Symbol.asyncIterator() which sets up
    // the fs.watchFile watcher while the file still exists.
    const collectPromise = collectEvents(iter, 2, 4000);

    // Let the watcher settle and initial 'add' event be queued (via queueMicrotask)
    await Bun.sleep(200);

    // Delete the file — fs.watchFile should detect ino transition → 'unlink'
    await unlink(filePath);

    const events = await collectPromise;
    controller.abort();

    const unlinkEvent = events.find((e) => e.path === filePath && e.kind === 'unlink');
    expect(unlinkEvent).toBeDefined();
  }, 10_000);

  // Lines 144-145: iterator return() method terminates the iterator and returns done=true
  test('iterator return() sets done=true and stops iteration', async () => {
    const dir = await setup();
    const controller = new AbortController();
    const iter = watch([dir], controller.signal);
    const iterator = iter[Symbol.asyncIterator]();

    // Call return() directly — exercises the return() method on lines 144-145
    // Our impl always defines return(), but the iterator-protocol type marks it optional.
    if (iterator.return === undefined) throw new Error('iterator.return missing');
    const returnResult = await iterator.return();
    expect(returnResult.done).toBe(true);

    // Subsequent next() calls must also return done=true (watcher closed)
    const nextResult = await iterator.next();
    expect(nextResult.done).toBe(true);

    controller.abort();
  });
});
