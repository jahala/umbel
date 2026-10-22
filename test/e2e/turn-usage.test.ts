import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';

// umbel#78: a conductor that pays for a turn can record its cost from a result
// it already reads. wait at stop and read --json both carry the turn's token
// usage, taken from the transcript read the verb already performs.

const FAKE_CLAUDE = join(import.meta.dir, '..', 'fixtures', 'fake-claude.sh');
const MAIN = join(import.meta.dir, '../../src/main.ts');

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
const CREATED: string[] = [];

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

const RECORDED_USAGE = {
  input_tokens: 123,
  output_tokens: 45,
  cache_read_input_tokens: 678,
  cache_creation_input_tokens: 9,
};

const EXPECTED_USAGE: Usage = {
  inputTokens: 123,
  outputTokens: 45,
  cacheReadTokens: 678,
  cacheWriteTokens: 9,
  model: 'fake-model',
};

afterEach(async () => {
  const env = { UMBEL_STATE: tmpDir };
  await Promise.all(CREATED.splice(0).map((n) => killSession(n, env).catch(() => undefined)));
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

// The fake's configuration rides in the CLI's environment and reaches the worker
// by name, since a worker inherits no FAKE_* variable on its own (umbel#93).
const passFake = (env: Record<string, string>): string[] =>
  Object.keys(env)
    .filter((k) => k.startsWith('FAKE_'))
    .flatMap((k) => ['--env', k]);

async function setup(): Promise<Record<string, string>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-usage-'));
  return {
    UMBEL_STATE: tmpDir,
    UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects'),
    FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    FAKE_CLAUDE_USAGE: JSON.stringify(RECORDED_USAGE),
    FAKE_CLAUDE_MODEL: 'fake-model',
  };
}

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

describe('token usage of a finished turn', () => {
  test('wait at stop and read --json both carry the usage the worker recorded', async () => {
    const env = await setup();
    const name = `u${RUN_ID}`;
    CREATED.push(name);

    const spawned = await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env);
    expect(spawned.stderr).toBe('');
    expect(spawned.code).toBe(0);

    // `send` and `wait` are separate processes, so the stop-mtime baseline
    // travels between them: send reports it, wait takes it as --since.
    const sent = await runCli(['send', name, 'hello', '--json'], env);
    expect(sent.code).toBe(0);
    const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };

    const waited = await runCli(
      ['wait', name, '--json', '--since', String(sinceMtime), '--timeout', '30s'],
      env,
    );
    expect(waited.code).toBe(0);
    const waitPayload = JSON.parse(waited.stdout) as { reason: string; usage?: Usage };
    expect(waitPayload.reason).toBe('stop');
    expect(waitPayload.usage).toEqual(EXPECTED_USAGE);

    // read takes the same usage from the same transcript, so the two verbs
    // cannot disagree about what the turn cost.
    const read = await runCli(['read', name, '--json'], env);
    expect(read.code).toBe(0);
    const readPayload = JSON.parse(read.stdout) as { text: string; usage?: Usage };
    expect(readPayload.text).toContain('Response to: hello');
    expect(readPayload.usage).toEqual(EXPECTED_USAGE);
  }, 120_000);
});
