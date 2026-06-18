import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  capturePane,
  hasSession,
  killSession,
  listSessions,
  newSession,
  sendText,
} from '../../src/adapters/tmux.ts';
import { TmuxError } from '../../src/core/errors.ts';

// Each test run uses a unique run-id so parallel runs don't collide.
const RUN_ID = randomBytes(4).toString('hex');
function sessionName(suffix: string): string {
  return `test-${RUN_ID}-${suffix}`;
}

const CREATED: string[] = [];

async function safeKill(name: string): Promise<void> {
  try {
    await killSession(name);
  } catch {
    // ignore — idempotent cleanup
  }
}

afterAll(async () => {
  await Promise.all(CREATED.map(safeKill));
});

describe('newSession + hasSession', () => {
  test('creates a session that hasSession detects', async () => {
    const name = sessionName('create');
    CREATED.push(name);
    await newSession({ name, cwd: '/tmp', cmd: ['bash'] });
    expect(await hasSession(name)).toBe(true);
  });

  test('hasSession returns false for non-existent session', async () => {
    expect(await hasSession(`no-such-session-${RUN_ID}`)).toBe(false);
  });
});

describe('listSessions', () => {
  test('returns only umbel-prefixed sessions we created', async () => {
    const name1 = sessionName('list1');
    const name2 = sessionName('list2');
    CREATED.push(name1, name2);
    await newSession({ name: name1, cwd: '/tmp', cmd: ['bash'] });
    await newSession({ name: name2, cwd: '/tmp', cmd: ['bash'] });

    const sessions = await listSessions();
    // All returned names must be bare (no umbel- prefix)
    for (const s of sessions) {
      expect(s.startsWith('umbel-')).toBe(false);
    }
    expect(sessions).toContain(name1);
    expect(sessions).toContain(name2);
  });
});

describe('sendText + capturePane', () => {
  let sessionForSend: string;

  beforeAll(async () => {
    sessionForSend = sessionName('send');
    CREATED.push(sessionForSend);
    await newSession({ name: sessionForSend, cwd: '/tmp', cmd: ['bash'] });
    // Wait briefly for bash to settle
    await Bun.sleep(300);
  });

  test('single-line send appears in capturePane', async () => {
    const marker = `UMBEL_SINGLE_${RUN_ID}`;
    await sendText(sessionForSend, `echo ${marker}`);
    await Bun.sleep(300);
    const output = await capturePane(sessionForSend, 50);
    expect(output).toContain(marker);
  });

  test('multi-line send all lines appear in capturePane', async () => {
    const markerA = `UMBEL_MULTI_A_${RUN_ID}`;
    const markerB = `UMBEL_MULTI_B_${RUN_ID}`;
    await sendText(sessionForSend, `echo ${markerA}\necho ${markerB}`);
    await Bun.sleep(500);
    const output = await capturePane(sessionForSend, 100);
    expect(output).toContain(markerA);
    expect(output).toContain(markerB);
  });

  test('long text (>1000 chars) uses load-buffer path', async () => {
    const longText = `echo UMBEL_LONG_${RUN_ID}_${'x'.repeat(1010)}`;
    await sendText(sessionForSend, longText);
    await Bun.sleep(500);
    const output = await capturePane(sessionForSend, 50);
    expect(output).toContain(`UMBEL_LONG_${RUN_ID}`);
  });
});

describe('killSession', () => {
  test('kill is idempotent — no error if session already gone', async () => {
    const name = sessionName('kill');
    CREATED.push(name);
    await newSession({ name, cwd: '/tmp', cmd: ['bash'] });
    await killSession(name);
    expect(await hasSession(name)).toBe(false);
    // Second kill must not throw
    await expect(killSession(name)).resolves.toBeUndefined();
  });
});

describe('concurrent sends to different sessions', () => {
  test('sends do not collide', async () => {
    const nameA = sessionName('concA');
    const nameB = sessionName('concB');
    CREATED.push(nameA, nameB);
    await newSession({ name: nameA, cwd: '/tmp', cmd: ['bash'] });
    await newSession({ name: nameB, cwd: '/tmp', cmd: ['bash'] });
    await Bun.sleep(200);

    const markerA = `CONC_A_${RUN_ID}`;
    const markerB = `CONC_B_${RUN_ID}`;
    await Promise.all([sendText(nameA, `echo ${markerA}`), sendText(nameB, `echo ${markerB}`)]);
    await Bun.sleep(400);

    const [outA, outB] = await Promise.all([capturePane(nameA, 50), capturePane(nameB, 50)]);
    expect(outA).toContain(markerA);
    expect(outB).toContain(markerB);
    // Markers must not cross-contaminate
    expect(outA).not.toContain(markerB);
    expect(outB).not.toContain(markerA);
  });
});

describe('TmuxError on invalid operations', () => {
  test('capturePane on non-existent session throws TmuxError', async () => {
    await expect(capturePane(`no-such-session-${RUN_ID}`, 10)).rejects.toBeInstanceOf(TmuxError);
  });
});

// ---------------------------------------------------------------------------
// Line 93: listSessions catch path — no server running
// This test runs last; it kills the server and tests that listSessions returns [].
// It then starts a new server so subsequent tests in other files are not affected.
// ---------------------------------------------------------------------------

describe('listSessions — no server (line 93 catch path)', () => {
  test('returns [] when tmux server is not running', async () => {
    // Clean up all test sessions first
    await Promise.all(CREATED.splice(0).map(safeKill));

    // Kill the tmux server
    const killProc = Bun.spawn(['tmux', 'kill-server'], { stdout: 'pipe', stderr: 'pipe' });
    await killProc.exited;
    // Brief pause so the server fully stops
    await Bun.sleep(200);

    // listSessions must catch the TmuxError and return empty array
    const sessions = await listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions).toEqual([]);

    // Restart the server with a dummy session so other tests still work
    const startProc = Bun.spawn(['tmux', 'new-session', '-d', '-s', `umbel-boot-${RUN_ID}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await startProc.exited;
    // Clean it up immediately
    const cleanProc = Bun.spawn(['tmux', 'kill-session', '-t', `umbel-boot-${RUN_ID}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await cleanProc.exited;
  });
});
