/**
 * Subscription rate-limit usage, read from claude's statusLine payload.
 *
 * The payload shape is claude's own documented example
 * (`.rate_limits.five_hour.used_percentage`), not a guess: the pane line that
 * bandung's report saw is presentational and would rot the same way the
 * startup-dialog matcher did. `rate_limits` is present only while the API
 * reports pressure, so absence is the normal case, not an error.
 */
import { describe, expect, test } from 'bun:test';
import { buildSettingsJson } from '../../src/adapters/hooks.ts';
import { parseQuota } from '../../src/core/quota.ts';

describe('parseQuota', () => {
  test('reads both windows and reports the sooner reset', () => {
    const q = parseQuota(
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 94, resets_at: '2026-09-05T21:20:00Z' },
          seven_day: { used_percentage: 41, resets_at: '2026-09-09T00:00:00Z' },
        },
      }),
    );
    expect(q).toEqual({
      fiveHourPct: 94,
      sevenDayPct: 41,
      resetsAt: '2026-09-05T21:20:00Z',
    });
  });

  test('a payload with no rate_limits is not an error — it means no pressure', () => {
    // Verbatim key set observed from a real statusLine invocation.
    expect(
      parseQuota(JSON.stringify({ model: {}, workspace: {}, context_window: {}, cost: {} })),
    ).toBeNull();
  });

  test('is total: malformed input yields null rather than throwing', () => {
    for (const bad of ['', 'not json', '[]', 'null', '{"rate_limits":null}', '{"rate_limits":7}']) {
      expect(parseQuota(bad)).toBeNull();
    }
  });

  test('a window with neither figure is ignored rather than reported empty', () => {
    expect(parseQuota(JSON.stringify({ rate_limits: { five_hour: {} } }))).toBeNull();
  });

  test('reports whichever window the API actually sent', () => {
    expect(
      parseQuota(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 12 } } })),
    ).toEqual({ sevenDayPct: 12 });
  });
});

describe('buildSettingsJson — statusLine', () => {
  test('registers the statusline script so the payload reaches umbel', () => {
    const s = JSON.parse(
      buildSettingsJson({ hookScriptPath: '/x/stop.sh', statusLineScriptPath: '/x/statusline.sh' }),
    ) as { statusLine?: { type?: string; command?: string } };
    expect(s.statusLine).toEqual({ type: 'command', command: '/x/statusline.sh' });
  });

  test('omitted when no script is supplied, so other providers are untouched', () => {
    const s = JSON.parse(buildSettingsJson({ hookScriptPath: '/x/stop.sh' })) as {
      statusLine?: unknown;
    };
    expect(s.statusLine).toBeUndefined();
  });
});
