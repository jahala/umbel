import { describe, expect, test } from 'bun:test';
import { formatIdleMessage } from '../../src/core/idle.ts';

// The formatter behind an idle result's message: given when each watched source
// last changed and the current time, one line naming every source.

describe('formatIdleMessage', () => {
  test('names every source in order with its stillness; the headline is the shortest', () => {
    const now = 10_000;
    expect(
      formatIdleMessage(
        [
          { name: 'pane', lastChangeAt: 8_400 },
          { name: 'events', lastChangeAt: 6_000 },
          { name: 'transcript', lastChangeAt: 8_300 },
          { name: 'subagents', lastChangeAt: 'absent' },
        ],
        now,
      ),
    ).toBe(
      'idle 1.6s: pane still 1.6s · events still 4.0s · transcript still 1.7s · subagents none',
    );
  });

  test('a source that could not be resolved is named unresolved', () => {
    expect(
      formatIdleMessage(
        [
          { name: 'pane', lastChangeAt: 1_000 },
          { name: 'events', lastChangeAt: 0 },
          { name: 'transcript', lastChangeAt: 'unresolved' },
        ],
        3_000,
      ),
    ).toBe('idle 2.0s: pane still 2.0s · events still 3.0s · transcript unresolved');
  });

  test('a change stamped after now (clock skew) reads as still 0.0s, never negative', () => {
    expect(formatIdleMessage([{ name: 'events', lastChangeAt: 5_500 }], 5_000)).toBe(
      'idle 0.0s: events still 0.0s',
    );
  });

  test('with no timed source the headline carries no duration', () => {
    expect(formatIdleMessage([{ name: 'transcript', lastChangeAt: 'unresolved' }], 5_000)).toBe(
      'idle: transcript unresolved',
    );
  });
});
