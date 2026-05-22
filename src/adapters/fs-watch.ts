import { type Stats, statSync, unwatchFile, watchFile } from 'node:fs';
import chokidar from 'chokidar';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchEvent {
  kind: 'add' | 'change' | 'unlink';
  path: string;
}

// ---------------------------------------------------------------------------
// watch — AsyncIterable over file system events, abort-signal aware
//
// Hybrid strategy:
//   - Directories use chokidar (FSEvents on macOS, polling on Linux).
//     Chokidar emits events with the path of the changed *file inside* the
//     directory, which is what callers expect.
//   - Files (and non-existent paths) use Node's native fs.watchFile, which
//     polls stat changes directly. Reliable across platforms — single-file
//     watching via chokidar is flaky on Linux even with usePolling.
//   - For non-existent paths we treat them as files: fs.watchFile polls
//     until the path appears.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 50;
const USE_POLLING = process.platform !== 'darwin';

function classify(path: string): 'dir' | 'file' {
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'file';
  }
}

export function watch(paths: string[], signal: AbortSignal): AsyncIterable<WatchEvent> {
  return {
    [Symbol.asyncIterator]() {
      const queue: WatchEvent[] = [];
      const resolvers: Array<(value: IteratorResult<WatchEvent>) => void> = [];
      let done = false;

      function enqueue(kind: WatchEvent['kind'], path: string): void {
        if (done) return;
        const event: WatchEvent = { kind, path };
        const resolver = resolvers.shift();
        if (resolver) {
          resolver({ value: event, done: false });
        } else {
          queue.push(event);
        }
      }

      // Partition paths by kind.
      const dirPaths: string[] = [];
      const filePaths: string[] = [];
      for (const p of paths) {
        if (classify(p) === 'dir') dirPaths.push(p);
        else filePaths.push(p);
      }

      // Chokidar handles dir watches (and any future descendants).
      const chokidarWatcher =
        dirPaths.length > 0
          ? chokidar.watch(dirPaths, {
              persistent: true,
              ignoreInitial: false,
              awaitWriteFinish: false,
              usePolling: USE_POLLING,
              interval: POLL_INTERVAL_MS,
              binaryInterval: POLL_INTERVAL_MS * 2,
            })
          : undefined;

      if (chokidarWatcher) {
        chokidarWatcher.on('add', (path) => enqueue('add', path));
        chokidarWatcher.on('change', (path) => enqueue('change', path));
        chokidarWatcher.on('unlink', (path) => enqueue('unlink', path));
      }

      // fs.watchFile handles single files (and non-existent paths). Node's
      // native polling reports stat transitions, including from "absent" to
      // "present".
      const fileListeners: Array<{ path: string; listener: (c: Stats, p: Stats) => void }> = [];
      for (const path of filePaths) {
        // fs.watchFile does NOT emit on the initial state. Chokidar (with
        // ignoreInitial: false) emits 'add' for existing files at watch start.
        // Match that contract: if the file currently exists, queue an 'add'
        // on the next tick (after the iterator's first next() can be awaited).
        try {
          if (statSync(path).isFile()) {
            queueMicrotask(() => enqueue('add', path));
          }
        } catch {
          // Doesn't exist yet — fs.watchFile will fire 'add' when it appears.
        }

        const listener = (curr: Stats, prev: Stats): void => {
          if (done) return;
          // Absent file has ino === 0 (fs.watchFile sentinel).
          const wasAbsent = prev.ino === 0;
          const isAbsent = curr.ino === 0;
          if (wasAbsent && !isAbsent) {
            enqueue('add', path);
          } else if (!wasAbsent && isAbsent) {
            enqueue('unlink', path);
          } else if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
            enqueue('change', path);
          }
        };
        watchFile(path, { interval: POLL_INTERVAL_MS, persistent: true }, listener);
        fileListeners.push({ path, listener });
      }

      function close(): void {
        if (done) return;
        done = true;
        if (chokidarWatcher) chokidarWatcher.close();
        for (const { path, listener } of fileListeners) {
          unwatchFile(path, listener);
        }
        for (const resolver of resolvers.splice(0)) {
          resolver({ value: undefined as unknown as WatchEvent, done: true });
        }
      }

      signal.addEventListener('abort', close);

      return {
        next(): Promise<IteratorResult<WatchEvent>> {
          if (done) {
            return Promise.resolve({ value: undefined as unknown as WatchEvent, done: true });
          }
          const queued = queue.shift();
          if (queued !== undefined) {
            return Promise.resolve({ value: queued, done: false });
          }
          return new Promise((resolve) => {
            resolvers.push(resolve);
          });
        },
        return(): Promise<IteratorResult<WatchEvent>> {
          close();
          return Promise.resolve({ value: undefined as unknown as WatchEvent, done: true });
        },
      };
    },
  };
}
