import { describe, expect, test } from 'bun:test';
import { describeDeath } from '../../src/core/death.ts';

// tmux names the signal that killed a pane as its own build does: macOS tmux
// 3.6b says `term`, ubuntu's tmux 3.4 says `15` (jahala/umbel#89, probe run
// 35047549038). Both are the same death and read the same.
describe('describeDeath', () => {
  test('a signal named by tmux reads as its SIG name', () => {
    expect(describeDeath({ exists: true, signal: 'term' })).toBe('killed by SIGTERM');
    expect(describeDeath({ exists: true, signal: 'SIGKILL' })).toBe('killed by SIGKILL');
  });

  test('a signal numbered by tmux reads as its SIG name too', () => {
    expect(describeDeath({ exists: true, signal: '15' })).toBe('killed by SIGTERM');
    expect(describeDeath({ exists: true, signal: '9' })).toBe('killed by SIGKILL');
  });

  test('an exit status reads as the status; nothing recorded says so', () => {
    expect(describeDeath({ exists: true, exitCode: 3 })).toBe('process exited 3');
    expect(describeDeath({ exists: true })).toBe('process exited, tmux recorded no status');
    expect(describeDeath({ exists: false })).toBe('tmux session is gone');
  });
});
