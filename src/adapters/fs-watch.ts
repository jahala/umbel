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
// ---------------------------------------------------------------------------

export function watch(paths: string[], signal: AbortSignal): AsyncIterable<WatchEvent> {
  return {
    [Symbol.asyncIterator]() {
      const queue: WatchEvent[] = [];
      const resolvers: Array<(value: IteratorResult<WatchEvent>) => void> = [];
      let done = false;

      const watcher = chokidar.watch(paths, {
        persistent: true,
        ignoreInitial: false,
        awaitWriteFinish: false,
      });

      function enqueue(kind: WatchEvent['kind'], path: string): void {
        const event: WatchEvent = { kind, path };
        const resolver = resolvers.shift();
        if (resolver) {
          resolver({ value: event, done: false });
        } else {
          queue.push(event);
        }
      }

      watcher.on('add', (path) => enqueue('add', path));
      watcher.on('change', (path) => enqueue('change', path));
      watcher.on('unlink', (path) => enqueue('unlink', path));

      function close(): void {
        if (done) return;
        done = true;
        watcher.close();
        // Drain all pending resolvers with done=true
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
