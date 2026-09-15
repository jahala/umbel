import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { dismissStartupDialogs } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// codex readiness is idle-and-settled (jahala/umbel#77). codex 0.154.0 keeps
// building its screen for seconds after the banner first paints: the banner
// re-renders, the usage-limit line arrives, and the workspace-trust dialog can
// land after all of that. These tests replay the frames recorded in
// test/fixtures/codex-0.154-startup.txt through a scripted tmux dependency.
// ---------------------------------------------------------------------------

const FIXTURE = readFileSync(join(import.meta.dir, '../fixtures/codex-0.154-startup.txt'), 'utf8');

function recording(n: 1 | 2): string[] {
  const start = FIXTURE.indexOf(`## Recording ${n}`);
  const end = n === 1 ? FIXTURE.indexOf('## Recording 2') : FIXTURE.length;
  return FIXTURE.slice(start, end).split('\n').slice(1);
}

// Recording 1 is one capture holding the whole startup: banner (model: loading)
// with its prompt line, the re-rendered banner, then the trust dialog. Each
// prefix is a frame the pane showed on the way there.
function recording1Frames(): {
  bannerOnly: string;
  loading: string;
  rerender: string;
  dialog: string;
} {
  const lines = recording(1).filter((l) => l.length > 0);
  const secondBox = lines.findIndex((l, i) => i > 0 && l.startsWith('╭'));
  const dialogStart = lines.findIndex((l) => l.startsWith('> You are in'));
  const firstBoxEnd = lines.findIndex((l) => l.startsWith('╰'));
  return {
    bannerOnly: lines.slice(0, firstBoxEnd + 1).join('\n'),
    loading: lines.slice(0, secondBox).join('\n'),
    rerender: lines.slice(0, dialogStart).join('\n'),
    dialog: lines.join('\n'),
  };
}

// Recording 2 is a series of timed captures (t=1s, 3s, 6s, 10s) of a launch
// that showed no dialog; the usage-limit line arrives between t=1s and t=3s.
function recording2Frames(): string[] {
  const frames: string[] = [];
  let current: string[] | null = null;
  for (const line of recording(2)) {
    if (line.startsWith('--- ')) {
      if (current !== null) frames.push(current.join('\n').trimEnd());
      current = line.startsWith('--- t=') ? [] : null;
      continue;
    }
    current?.push(line);
  }
  if (current !== null) frames.push(current.join('\n').trimEnd());
  return frames;
}

type Hold = number | 'until-keys';
interface Step {
  readonly pane: string;
  readonly hold: Hold;
}

// A tmux that serves each step's pane for `hold` captures (the last step
// forever); a 'until-keys' step stays on the pane until keys are sent while it
// shows, as a real dialog does. Records what was sent on which step, and when
// the served pane last changed.
function scriptedTmux(steps: readonly Step[]) {
  const sent: { keys: string[]; step: number }[] = [];
  let step = 0;
  let served = 0;
  let keysOnStep = false;
  let lastPane: string | null = null;
  let lastChangeAt = 0;
  const tmux = {
    capturePane: async (): Promise<string> => {
      const s = steps[step];
      if (s === undefined) throw new Error('no step');
      const done = s.hold === 'until-keys' ? keysOnStep : served >= s.hold;
      if (done && step < steps.length - 1) {
        step++;
        served = 0;
        keysOnStep = false;
      }
      served++;
      const pane = steps[step]?.pane ?? '';
      if (pane !== lastPane) {
        lastPane = pane;
        lastChangeAt = Date.now();
      }
      return pane;
    },
    sendKeys: async (_name: string, keys: readonly string[]): Promise<void> => {
      sent.push({ keys: [...keys], step });
      keysOnStep = true;
    },
  };
  return {
    tmux,
    sent,
    state: () => ({ step, lastChangeAt }),
  };
}

const settleMs = CodexProvider.readySettleMs ?? 0;

async function replay(steps: readonly Step[]) {
  const t = scriptedTmux(steps);
  await dismissStartupDialogs(
    { tmux: t.tmux } as never,
    'sess',
    CodexProvider.startupDialogs ?? [],
    CodexProvider.readyMatch,
    CodexProvider.readySettleMs,
  );
  const returnedAt = Date.now();
  const { step, lastChangeAt } = t.state();
  return { sent: t.sent, returnedOnStep: step, stableForMs: returnedAt - lastChangeAt };
}

describe('codex readiness (0.154.0 recorded startup)', () => {
  test('codex declares a settle window', () => {
    expect(settleMs).toBeGreaterThan(0);
  });

  test('the banner alone is not ready; the idle prompt line is', () => {
    const { bannerOnly, loading } = recording1Frames();
    const ready = CodexProvider.readyMatch ?? /$^/;
    expect(ready.test(bannerOnly)).toBe(false);
    expect(ready.test(loading)).toBe(true);
    expect(ready.test('Implement {feature}')).toBe(true);
  });

  test('late trust dialog: dismissed with Enter, returns only after the final frame settles', async () => {
    const r1 = recording1Frames();
    const r2 = recording2Frames();
    expect(r2.length).toBeGreaterThanOrEqual(3);
    const steps: Step[] = [
      { pane: r1.bannerOnly, hold: 3 },
      { pane: r1.loading, hold: 3 },
      { pane: r1.rerender, hold: 3 },
      { pane: r1.dialog, hold: 'until-keys' },
      ...r2.map((pane) => ({ pane, hold: 3 })),
    ];
    const dialogStep = 3;
    const lastStep = steps.length - 1;

    const { sent, returnedOnStep, stableForMs } = await replay(steps);

    // Enter for the trust dialog, sent while it showed; nothing on any other frame.
    expect(sent).toEqual([{ keys: ['Enter'], step: dialogStep }]);
    // Did not return on the banner, the re-render, or while the dialog showed.
    expect(returnedOnStep).toBe(lastStep);
    // Returned only once the final frame had been unchanged for the window.
    expect(stableForMs).toBeGreaterThanOrEqual(settleMs);
  }, 15_000);

  test('no dialog: sends nothing, waits out the usage-limit re-render and the settle window', async () => {
    const r1 = recording1Frames();
    const r2 = recording2Frames();
    const steps: Step[] = [{ pane: r1.loading, hold: 3 }, ...r2.map((pane) => ({ pane, hold: 3 }))];

    const { sent, returnedOnStep, stableForMs } = await replay(steps);

    expect(sent).toEqual([]);
    expect(returnedOnStep).toBe(steps.length - 1);
    expect(stableForMs).toBeGreaterThanOrEqual(settleMs);
  }, 15_000);

  test('a banner held longer than the settle window is still not ready', async () => {
    const r1 = recording1Frames();
    // 20 polls of the bare banner outlast the settle window.
    const steps: Step[] = [
      { pane: r1.bannerOnly, hold: 20 },
      { pane: r1.loading, hold: 1 },
    ];

    const { sent, returnedOnStep, stableForMs } = await replay(steps);

    expect(sent).toEqual([]);
    expect(returnedOnStep).toBe(1);
    expect(stableForMs).toBeGreaterThanOrEqual(settleMs);
  }, 15_000);
});
