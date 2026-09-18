import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Every tmux client goes through adapters/tmux.ts, which puts it on the state
// root's private socket and bounds it. A tmux started anywhere else lands on
// the default socket, where no worker lives: `umbel attach` did exactly that.
// ---------------------------------------------------------------------------

const SRC = join(import.meta.dir, '../../src');
const ADAPTER = 'adapters/tmux.ts';
// An argv whose program is tmux: ['tmux', ...
const TMUX_ARGV = /\[\s*['"`]tmux['"`]\s*[,\]]/;

describe('tmux is started only by its adapter', () => {
  test('no other source file builds a tmux argv', () => {
    const offenders = [...new Bun.Glob('**/*.ts').scanSync(SRC)]
      .filter((file) => file !== ADAPTER)
      .filter((file) => TMUX_ARGV.test(readFileSync(join(SRC, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('the check finds a tmux argv where one is built', () => {
    // Guards the guard: the adapter itself must match, or the pattern is dead.
    expect(TMUX_ARGV.test(readFileSync(join(SRC, ADAPTER), 'utf8'))).toBe(true);
  });
});
