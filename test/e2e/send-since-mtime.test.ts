import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { killSession } from '../../src/adapters/tmux.ts';

// ---------------------------------------------------------------------------
// umbel#74: a conductor reported that every umbel_send over MCP returned
// {"sinceMtime":0}, even after completed turns. send snapshots the mtime of
// events/stop before typing; 0 means "the file did not exist yet", which is
// correct only before a worker's first stop. These tests pin both halves
// through the CLI and the MCP face: the first send of a fresh worker returns 0,
// and the next send after a turn completed returns the stop file's mtime, the
// exact baseline wait needs for race-free stop detection.
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_CLAUDE = join(import.meta.dir, '..', 'fixtures', 'fake-claude.sh');
const RUN_ID = randomBytes(4).toString('hex');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(['bun', 'run', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

interface Worker {
  name: string;
  env: Record<string, string>;
  root: string;
  state: string;
}

const CREATED: Worker[] = [];

async function spawnClaude(): Promise<Worker> {
  const root = await mkdtemp(join(tmpdir(), 'umbel-since-74-'));
  const state = join(root, 'state');
  const cwd = join(root, 'cwd');
  await Promise.all([mkdir(state), mkdir(cwd)]);
  const name = `s${RUN_ID}${CREATED.length}`;
  const env: Record<string, string> = {
    UMBEL_STATE: state,
    UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
  };
  const fake: Record<string, string> = {
    FAKE_CLAUDE_JSONL_DIR: cwd,
    FAKE_CLAUDE_HOOK: join(state, 'hooks', 'stop.sh'),
  };
  const envFlags = Object.entries(fake).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

  const spawned = await runCli(
    ['spawn', '--provider', 'claude', '--name', name, '--cwd', cwd, ...envFlags],
    env,
  );
  expect(spawned.stderr).toBe('');
  expect(spawned.code).toBe(0);
  const worker = { name, env, root, state };
  CREATED.push(worker);
  return worker;
}

async function stopMtime(w: Worker): Promise<number> {
  return (await stat(join(w.state, 'sessions', w.name, 'events', 'stop'))).mtimeMs;
}

afterEach(async () => {
  await Promise.all(
    CREATED.splice(0).map(async (w) => {
      await killSession(w.name, w.env).catch(() => undefined);
      await rm(w.root, { recursive: true, force: true });
    }),
  );
});

describe('send sinceMtime — 0 before the first stop, the stop file afterwards', () => {
  test('CLI: the second send returns the stop file mtime', async () => {
    const w = await spawnClaude();

    const first = await runCli(['send', '--json', w.name, 'first turn'], w.env);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect((JSON.parse(first.stdout) as { sinceMtime: number }).sinceMtime).toBe(0);

    const waited = await runCli(
      ['wait', '--json', '--since', '0', '--timeout', '20s', w.name],
      w.env,
    );
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.stdout.trim())).toMatchObject({ reason: 'stop' });

    const completedStop = await stopMtime(w);
    const second = await runCli(['send', '--json', w.name, 'second turn'], w.env);
    expect(second.stderr).toBe('');
    expect(second.code).toBe(0);
    const { sinceMtime } = JSON.parse(second.stdout) as { sinceMtime: number };
    expect(sinceMtime).toBeGreaterThan(0);
    expect(sinceMtime).toBe(completedStop);
  }, 60_000);

  test('MCP: the second umbel_send returns the stop file mtime', async () => {
    const w = await spawnClaude();
    const client = new Client({ name: 'send-since-74-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: 'bun',
        args: ['run', MAIN, 'mcp'],
        env: { ...(process.env as Record<string, string>), UMBEL_STATE: w.state },
      }),
    );
    try {
      const first = await client.callTool({
        name: 'umbel_send',
        arguments: { name: w.name, prompt: 'first turn' },
      });
      const firstText = (first.content as Array<{ text: string }>)[0]?.text ?? '';
      expect((JSON.parse(firstText) as { sinceMtime: number }).sinceMtime).toBe(0);

      const waited = await client.callTool({
        name: 'umbel_wait',
        arguments: { name: w.name, sinceMtime: 0, timeout: '20s' },
      });
      const waitText = (waited.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(JSON.parse(waitText)).toMatchObject({ reason: 'stop' });

      const completedStop = await stopMtime(w);
      const second = await client.callTool({
        name: 'umbel_send',
        arguments: { name: w.name, prompt: 'second turn' },
      });
      const secondText = (second.content as Array<{ text: string }>)[0]?.text ?? '';
      const { sinceMtime } = JSON.parse(secondText) as { sinceMtime: number };
      expect(sinceMtime).toBeGreaterThan(0);
      expect(sinceMtime).toBe(completedStop);
    } finally {
      await client.close();
    }
  }, 60_000);
});
