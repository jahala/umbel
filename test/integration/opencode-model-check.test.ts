/**
 * A --model opencode does not list refuses the spawn before a worker exists
 * (umbel#53).
 *
 * opencode falls back to another provider when the requested model is
 * unknown, so a request for a free local model could silently become a paid
 * remote one. spawn consults `opencode models` on the same binary the launch
 * uses, and refuses an unlisted model before the plugin install, the session
 * dir or tmux are touched. Drives the real spawn operation and the real CLI
 * face against fake-opencode.sh, whose `models` verb prints a fixed list;
 * XDG_CONFIG_HOME and UMBEL_STATE live under a tmp dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSession, killSession } from '../../src/adapters/tmux.ts';
import { runCli } from '../../src/faces/cli.ts';
import { spawn } from '../../src/operations/spawn.ts';

const RUN_ID = randomBytes(4).toString('hex');
const FAKE_OPENCODE = join(import.meta.dir, '../fixtures/fake-opencode.sh');
// What fake-opencode.sh `models` prints.
const LISTED = ['opencode/big-pickle', 'ollama/some-model'];

let tmpDir = '';
const CREATED: string[] = [];

async function setup(): Promise<{
  env: Record<string, string | undefined>;
  cfgPath: string;
  cwd: string;
}> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-oc-model-'));
  const xdg = join(tmpDir, 'xdg');
  const cwd = join(tmpDir, 'cwd');
  await mkdir(cwd, { recursive: true });
  return {
    env: { UMBEL_STATE: tmpDir, XDG_CONFIG_HOME: xdg },
    cfgPath: join(xdg, 'opencode', 'opencode.jsonc'),
    cwd,
  };
}

function sessionName(suffix: string): string {
  const name = `m${RUN_ID}${suffix}`;
  CREATED.push(name);
  return name;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

// Nothing a spawn creates may exist: no tmux session, no session dir, and no
// plugin install into the user's opencode config.
async function expectNothingCreated(
  name: string,
  env: Record<string, string | undefined>,
  cfgPath: string,
): Promise<void> {
  expect(await hasSession(name, env)).toBe(false);
  expect(await exists(join(tmpDir, 'sessions', name))).toBe(false);
  expect(await exists(cfgPath)).toBe(false);
}

afterEach(async () => {
  await Promise.all(
    CREATED.splice(0).map((n) => killSession(n, { UMBEL_STATE: tmpDir }).catch(() => undefined)),
  );
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('spawn --provider opencode --model', () => {
  test('a model opencode does not list rejects with ModelUnknownError and creates nothing', async () => {
    const { env, cfgPath, cwd } = await setup();
    const name = sessionName('u');

    const err = await rejection(
      spawn({
        provider: 'opencode',
        claudeBin: FAKE_OPENCODE,
        model: 'ollama/qwen3-coder',
        cwd,
        env,
        name,
      }),
    );

    expect(err).toBeInstanceOf(Error);
    const refused = err as Error & { model?: unknown; listed?: unknown };
    expect(refused.name).toBe('ModelUnknownError');
    expect(refused.model).toBe('ollama/qwen3-coder');
    expect(refused.listed).toEqual(LISTED);
    expect(refused.message).toContain('ollama/qwen3-coder');
    for (const id of LISTED) expect(refused.message).toContain(id);
    await expectNothingCreated(name, env, cfgPath);
  });

  test('a listed model launches the worker with -m <model>', async () => {
    const { env, cwd } = await setup();
    const name = sessionName('l');
    const argvFile = join(tmpDir, 'argv');

    const { session } = await spawn({
      provider: 'opencode',
      claudeBin: FAKE_OPENCODE,
      model: 'ollama/some-model',
      cwd,
      env: { ...env, FAKE_OPENCODE_ARGV: argvFile },
      name,
    });

    expect(session.model).toBe('ollama/some-model');
    expect(await hasSession(name, env)).toBe(true);
    const argv = (await readFile(argvFile, 'utf8')).trimEnd().split('\n');
    const at = argv.indexOf('-m');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(argv[at + 1]).toBe('ollama/some-model');
  });

  test('the probe runs with the launch env, so a model only that env makes visible is accepted', async () => {
    const { env, cwd } = await setup();
    const name = sessionName('e');

    const { session } = await spawn({
      provider: 'opencode',
      claudeBin: FAKE_OPENCODE,
      model: 'lmstudio/local-only',
      cwd,
      env: { ...env, FAKE_OPENCODE_MODELS_EXTRA: 'lmstudio/local-only' },
      name,
    });

    expect(session.model).toBe('lmstudio/local-only');
    expect(await hasSession(name, env)).toBe(true);
  });

  test('a probe that fails refuses the spawn with its stderr and creates nothing', async () => {
    const { env, cfgPath, cwd } = await setup();
    const name = sessionName('f');

    const err = await rejection(
      spawn({
        provider: 'opencode',
        claudeBin: FAKE_OPENCODE,
        model: 'opencode/big-pickle',
        cwd,
        env: { ...env, FAKE_OPENCODE_MODELS_EXIT: '3' },
        name,
      }),
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('model catalogue unavailable');
    await expectNothingCreated(name, env, cfgPath);
  });

  test('umbel spawn exits 2 naming the model and the listed ids, with no session', async () => {
    const { env, cfgPath, cwd } = await setup();
    const name = sessionName('c');

    const saved = {
      UMBEL_STATE: process.env.UMBEL_STATE,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      UMBEL_CLAUDE_BIN: process.env.UMBEL_CLAUDE_BIN,
    };
    process.env.UMBEL_STATE = env.UMBEL_STATE;
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    process.env.UMBEL_CLAUDE_BIN = FAKE_OPENCODE;
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let code: number;
    try {
      code = await runCli([
        'spawn',
        '--provider',
        'opencode',
        '--model',
        'ollama/qwen3-coder',
        '--name',
        name,
        '--cwd',
        cwd,
      ]);
    } finally {
      process.stderr.write = origWrite;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    const out = stderr.join('');
    expect(code).toBe(2);
    expect(out).toContain('ollama/qwen3-coder');
    for (const id of LISTED) expect(out).toContain(id);
    await expectNothingCreated(name, env, cfgPath);
  });
});
