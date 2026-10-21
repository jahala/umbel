/**
 * jahala/umbel#118 end to end: a CLI a worker starts inherits UMBEL_STATE and
 * UMBEL_SESSION_ID, so its hook fires the worker's own stop. A real claude
 * worker running `opencode` by hand settled `wait` mid-turn this way.
 *
 * The fake worker fires a stop hook under another session's id in the middle of
 * its turn, then keeps working. Only the worker's own stop may settle `wait`,
 * and the nested one must leave events/stop, events/transcript-path and
 * events/log untouched. Identity is bound by the provider's start event; with
 * nothing bound, the old behaviour stands.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';

const FAKE_CLAUDE = join(import.meta.dir, '..', 'fixtures', 'fake-claude.sh');
const MAIN = join(import.meta.dir, '../../src/main.ts');

// Longer than read-at-stop's settle window: a stop taken mid-turn finds the
// fake's partial entry and waits out the window before reading it, while the
// outer turn is still running.
const POST_NESTED_MS = 6500;
const OUTER_PROMPT = 'outer turn';
const NESTED_TRANSCRIPT_CONTENT =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"nested reply"}]}}';

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
const CREATED: string[] = [];

afterEach(async () => {
  const env = { UMBEL_STATE: tmpDir };
  await Promise.all(CREATED.splice(0).map((n) => killSession(n, env).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

function sessionName(suffix: string): string {
  return `n${RUN_ID}${suffix}`;
}

// A worker inherits no FAKE_* variable on its own (umbel#93), so each rides in
// by name through --env.
const passFake = (env: Record<string, string>): string[] =>
  Object.keys(env)
    .filter((k) => k.startsWith('FAKE_'))
    .flatMap((k) => ['--env', k]);

async function setup(fake: Record<string, string> = {}): Promise<Record<string, string>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-nested-cli-'));
  return {
    UMBEL_STATE: tmpDir,
    UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects'),
    FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    FAKE_CLAUDE_NESTED_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    FAKE_CLAUDE_NESTED_TRANSCRIPT: join(tmpDir, 'nested.jsonl'),
    FAKE_CLAUDE_POST_NESTED_MS: String(POST_NESTED_MS),
    ...fake,
  };
}

function sessionDir(name: string): string {
  return join(tmpDir, 'sessions', name);
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

// send and wait are separate processes, so the stop-mtime baseline travels
// between them: send reports it, wait takes it as --since.
async function turn(name: string, prompt: string, env: Record<string, string>): Promise<RunResult> {
  const sent = await runCli(['send', name, prompt, '--json'], env);
  expect(sent.code).toBe(0);
  const { sinceMtime } = JSON.parse(sent.stdout) as { sinceMtime: number };
  return await runCli(
    ['wait', name, '--json', '--since', String(sinceMtime), '--timeout', '30s'],
    env,
  );
}

describe('a CLI a worker starts must not fire the worker stop', () => {
  test('the nested stop is ignored; wait settles on the worker own stop', async () => {
    const env = await setup({
      FAKE_CLAUDE_BIND_HOOK: join(tmpDir, 'hooks', 'bind.sh'),
    });
    await Bun.write(join(tmpDir, 'nested.jsonl'), NESTED_TRANSCRIPT_CONTENT);
    const name = sessionName('own');
    CREATED.push(name);

    const spawned = await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env);
    expect(spawned.code).toBe(0);

    const waited = await turn(name, OUTER_PROMPT, env);
    expect(waited.code).toBe(0);
    const payload = JSON.parse(waited.stdout) as { reason?: string; message?: string };
    expect(payload).toMatchObject({ reason: 'stop' });
    // The stop wait settled on carried the turn's final message.
    expect(payload.message).toBeUndefined();

    // The start event bound the worker's own id.
    expect(await readFile(join(sessionDir(name), 'events', 'worker-session'), 'utf8')).toBe(name);
    // The turn that settled wait is the outer one: its final message is on disk.
    const read = await runCli(['read', name], env);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain(`Response to: ${OUTER_PROMPT}`);
    // The nested payload carried its own transcript path; it never replaced ours.
    const transcriptPath = await readFile(
      join(sessionDir(name), 'events', 'transcript-path'),
      'utf8',
    );
    expect(transcriptPath.trim()).toBe(join(tmpDir, 'projects', `${name}.jsonl`));
  }, 120_000);

  test('with nothing bound yet, the nested stop still counts (today behaviour)', async () => {
    const env = await setup();
    await Bun.write(join(tmpDir, 'nested.jsonl'), NESTED_TRANSCRIPT_CONTENT);
    const name = sessionName('unbound');
    CREATED.push(name);

    const spawned = await runCli(['spawn', '--name', name, '--cwd', tmpDir, ...passFake(env)], env);
    expect(spawned.code).toBe(0);

    const waited = await turn(name, OUTER_PROMPT, env);
    expect(waited.code).toBe(0);
    // The nested stop was counted: wait reports that the handback it saw was
    // not the worker's own final message.
    const payload = JSON.parse(waited.stdout) as { reason?: string; message?: string };
    expect(payload).toMatchObject({ reason: 'stop' });
    expect(payload.message).toContain('not in the transcript');
  }, 120_000);
});
