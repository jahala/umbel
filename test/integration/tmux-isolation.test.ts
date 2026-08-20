/**
 * Socket isolation.
 *
 * umbel used to put every worker on the default tmux socket, alongside the
 * user's own sessions and every other agent's. Anything that reaps that server
 * — a stray `tmux kill-server`, a user tidying up, another agent's cleanup —
 * takes the whole fleet with it, silently: a vanished session leaves no pane
 * and no log, and is indistinguishable from a worker that died on its own.
 *
 * The socket is derived from the state root, so a worker set is only visible to
 * umbel invocations sharing that root. Tests, which use a temp UMBEL_STATE, are
 * therefore isolated from real workers by construction rather than by care.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasSession,
  killSession,
  listSessions,
  newSession,
  socketFor,
} from '../../src/adapters/tmux.ts';

const RUN_ID = randomBytes(4).toString('hex');
const CREATED: Array<{ name: string; env: Record<string, string | undefined> }> = [];

afterEach(async () => {
  await Promise.all(
    CREATED.splice(0).map(({ name, env }) => killSession(name, env).catch(() => undefined)),
  );
});

async function root(): Promise<Record<string, string | undefined>> {
  return { UMBEL_STATE: await mkdtemp(join(tmpdir(), 'umbel-iso-')) };
}

async function live(name: string, env: Record<string, string | undefined>): Promise<void> {
  await newSession({ name, cwd: '/tmp', cmd: ['sh', '-c', 'sleep 30'] }, env);
  CREATED.push({ name, env });
}

// Socket NAMING is a pure function and is unit-tested below. These exercise the
// runtime consequence — that a session on one socket genuinely cannot be seen
// from another — with explicit socket names, because the whole test run is
// pinned to a single socket by test/setup.ts and would otherwise agree with
// itself no matter what the derivation did.
describe('tmux socket isolation', () => {
  test('a session on one socket is invisible from another', async () => {
    const a = { ...(await root()), UMBEL_TMUX_SOCKET: `umbel-iso-${RUN_ID}-a` };
    const b = { ...(await root()), UMBEL_TMUX_SOCKET: `umbel-iso-${RUN_ID}-b` };
    const name = `iso-${RUN_ID}-a`;

    await live(name, a);

    expect(await hasSession(name, a)).toBe(true);
    expect(await hasSession(name, b)).toBe(false);
    expect(await listSessions(b)).not.toContain(name);
  });

  describe('socketFor — derivation', () => {
    // Cleared for these, since the pinned override short-circuits derivation by
    // design and would make every assertion below vacuously true.
    const pinned = process.env.UMBEL_TMUX_SOCKET;
    beforeEach(() => {
      delete process.env.UMBEL_TMUX_SOCKET;
    });
    afterAll(() => {
      if (pinned !== undefined) process.env.UMBEL_TMUX_SOCKET = pinned;
    });

    test('different state roots derive different sockets', () => {
      expect(socketFor({ UMBEL_STATE: '/tmp/root-a' })).not.toBe(
        socketFor({ UMBEL_STATE: '/tmp/root-b' }),
      );
    });

    test('the same state root derives the same socket', () => {
      expect(socketFor({ UMBEL_STATE: '/tmp/root-a' })).toBe(
        socketFor({ UMBEL_STATE: '/tmp/root-a' }),
      );
    });

    test('never the default socket, whatever the root', () => {
      for (const root of ['/tmp/a', '/tmp/b', undefined]) {
        expect(socketFor(root !== undefined ? { UMBEL_STATE: root } : {})).toMatch(/^umbel-/);
      }
    });

    test('an explicit socket overrides derivation', () => {
      expect(socketFor({ UMBEL_STATE: '/tmp/root-a', UMBEL_TMUX_SOCKET: 'chosen' })).toBe('chosen');
    });
  });

  // The guarantee that actually matters: a `tmux kill-server` by the user, or
  // by anything else on the default socket, cannot reach an umbel worker.
  test('umbel workers do not appear on the default tmux socket', async () => {
    const a = await root();
    const name = `iso-${RUN_ID}-default`;

    await live(name, a);
    expect(await hasSession(name, a)).toBe(true);

    // Read the default socket directly — deliberately not through the adapter.
    const proc = Bun.spawn(['tmux', 'list-sessions', '-F', '#{session_name}'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const listed = await new Response(proc.stdout).text();
    await proc.exited;

    expect(listed).not.toContain(name);
  });

  test('two roots sharing an explicit socket can see each other', async () => {
    const shared = `umbel-shared-${RUN_ID}`;
    const a = { ...(await root()), UMBEL_TMUX_SOCKET: shared };
    const b = { ...(await root()), UMBEL_TMUX_SOCKET: shared };
    const name = `iso-${RUN_ID}-shared`;

    await live(name, a);

    expect(await hasSession(name, b)).toBe(true);
  });
});
