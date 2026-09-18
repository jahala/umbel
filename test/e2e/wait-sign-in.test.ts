import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionDir, writeMeta } from '../../src/adapters/fs-state.ts';
import { killSession, newSession } from '../../src/adapters/tmux.ts';
import { SessionSchema } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// umbel#105 through the CLI a conductor calls: a worker on its CLI's sign-in
// screen ends `wait --json` as input (exit 126), and the JSON says it is a
// sign-in. The MCP face carried inputReason; the CLI's JSON did not.
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');
const SIGN_IN = join(import.meta.dir, '../fixtures/sign-in/gemini-0.46.0-sign-in.txt');
let tmpDir = '';
let name = '';

afterEach(async () => {
  if (name !== '') await killSession(name, { UMBEL_STATE: tmpDir }).catch(() => undefined);
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
  name = '';
});

describe('umbel wait --json on a worker at its sign-in screen', () => {
  test('exits 126 with inputReason sign-in and the line', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-wait-sign-in-e2e-'));
    const env = { UMBEL_STATE: tmpDir };
    name = `t${randomBytes(4).toString('hex')}signin`;
    await ensureSessionDir(name, env);
    await newSession(
      { name, cwd: '/tmp', cmd: ['bash', '-c', `cat '${SIGN_IN}'; exec sleep 60`] },
      env,
    );
    await writeMeta(
      name,
      SessionSchema.parse({
        name,
        cwd: '/tmp',
        anonymous: false,
        createdAt: Date.now(),
        jsonlPath: null,
        provider: 'gemini',
      }),
      env,
    );

    const proc = Bun.spawn(['bun', 'run', MAIN, 'wait', '--json', '--timeout', '20s', name], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(code).toBe(126);
    const result = JSON.parse(stdout.trim()) as {
      reason: string;
      inputReason?: string;
      message?: string;
    };
    expect(result.reason).toBe('input');
    expect(result.inputReason).toBe('sign-in');
    expect(result.message).toContain('How would you like to authenticate for this project?');
  }, 30_000);
});
