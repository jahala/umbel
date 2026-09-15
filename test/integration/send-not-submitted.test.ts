import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSession, killSession } from '../../src/adapters/tmux.ts';
import { runCli } from '../../src/faces/cli.ts';
import { send } from '../../src/operations/send.ts';
import { spawn } from '../../src/operations/spawn.ts';

// A codex that never takes the paste leaves `[Pasted Content N chars]` in its
// input box however often Enter is pressed (jahala/umbel#77). Once the bounded
// re-Enters are spent, send must fail with a typed error carrying the pane so
// the caller can see the stuck prompt, instead of returning as if a turn began
// and leaving a conductor to wait out its timeout. Nothing more is typed, and
// the worker is left alive for the caller to inspect or kill.

const PROMPT = 'summarise the repository';
// The submitting Enter plus send's bound of three extra Enters.
const ENTERS = 4;
const PENDING_LINE = `[Pasted Content ${PROMPT.length} chars]`;

const DIRS: string[] = [];
const CREATED: Array<{ name: string; env: Record<string, string> }> = [];

afterEach(async () => {
  await Promise.all(
    CREATED.splice(0).map((w) => killSession(w.name, w.env).catch(() => undefined)),
  );
  await Promise.all(DIRS.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  DIRS.push(dir);
  return dir;
}

async function codexThatNeverTakesThePaste() {
  const state = await tmp('umbel-not-submitted-');
  const userCodex = await tmp('umbel-not-submitted-codex-home-');
  const cwd = await tmp('umbel-not-submitted-cwd-');
  await writeFile(join(userCodex, 'auth.json'), '{"OPENAI_API_KEY":"fake"}');
  await writeFile(join(userCodex, 'config.toml'), 'model = "fake-model"\n');
  const stdinLog = join(cwd, 'stdin.log');
  const env = { UMBEL_STATE: state, CODEX_HOME: userCodex };
  const { session } = await spawn({
    cwd,
    provider: 'codex',
    claudeBin: join(import.meta.dir, '../fixtures/fake-codex.sh'),
    env: {
      ...env,
      FAKE_CODEX_JSONL_DIR: cwd,
      FAKE_CODEX_HOOK: join(state, 'hooks', 'stop.sh'),
      FAKE_CODEX_SWALLOW_ENTERS: '99',
      FAKE_CODEX_STDIN_LOG: stdinLog,
    },
  });
  CREATED.push({ name: session.name, env });
  return { name: session.name, env, cwd, state, stdinLog };
}

async function stdinLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').slice(0, -1);
}

async function rolloutTypes(cwd: string, sessionName: string): Promise<string[]> {
  const text = await readFile(join(cwd, `${sessionName}.jsonl`), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const line = JSON.parse(l) as { type: string; payload?: { type?: string } };
      return line.payload?.type ?? line.type;
    });
}

describe('send — fails when the prompt never lands', () => {
  test('throws SendNotSubmittedError carrying the pane, types nothing more, leaves the worker alive', async () => {
    const w = await codexThatNeverTakesThePaste();

    const err = await send({ name: w.name, prompt: PROMPT, env: w.env }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: 'SendNotSubmittedError',
      sessionName: w.name,
      enters: ENTERS,
      paneSnapshot: expect.stringContaining(PENDING_LINE),
    });

    // Give a stray keystroke time to reach the fake before reading its stdin.
    await Bun.sleep(1500);
    expect(await stdinLines(w.stdinLog)).toEqual([PROMPT, ...Array(ENTERS - 1).fill('')]);
    expect(await rolloutTypes(w.cwd, w.name)).not.toContain('user_message');
    expect(await hasSession(w.name, w.env)).toBe(true);
  }, 30_000);

  test('the CLI exits 1 quoting the pending input line and the Enters sent', async () => {
    const w = await codexThatNeverTakesThePaste();
    const savedState = process.env.UMBEL_STATE;
    process.env.UMBEL_STATE = w.state;

    let stderr = '';
    const origStderr = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    };
    let code: number;
    try {
      code = await runCli(['send', w.name, PROMPT]);
    } finally {
      process.stderr.write = origStderr;
      if (savedState === undefined) delete process.env.UMBEL_STATE;
      else process.env.UMBEL_STATE = savedState;
    }

    expect(code).toBe(1);
    const lines = stderr.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(w.name);
    expect(lines[0]).toContain(PENDING_LINE);
    expect(lines[0]).toContain(String(ENTERS));
    expect(await hasSession(w.name, w.env)).toBe(true);
  }, 30_000);
});
