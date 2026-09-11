/**
 * jahala/umbel#53 end to end: the user's opencode config survives
 * `umbel spawn --provider opencode`.
 *
 * Runs the real CLI entry in a subprocess against fake-opencode.sh (injected
 * via UMBEL_CLAUDE_BIN, whose `models` verb lists opencode/big-pickle and
 * ollama/some-model), with UMBEL_STATE and XDG_CONFIG_HOME under a tmp dir so
 * the user's real ~/.config/opencode is never touched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { hasSession, killSession } from '../../src/adapters/tmux.ts';

const RUN_ID = randomBytes(4).toString('hex');
const MAIN = join(import.meta.dir, '../../src/main.ts');
const FAKE_OPENCODE = join(import.meta.dir, '../fixtures/fake-opencode.sh');

// jahala/umbel#53, Case A, verbatim: a `//` comment inside a provider block.
const CASE_A = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["~/.umbel/hooks/opencode-stop.ts"],
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      // this comment is legal JSONC and accepted by opencode
      "models": { "some-model": { "name": "Some Model" } }
    }
  }
}
`;

// The other JSONC forms the issue's regression list names: `/* */` comments
// and trailing commas, in the plugin array and in an object.
const COMMENTED = `/* user config, hand-edited */
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["npm-plugin",],
  "model": "ollama/some-model", // pinned
  "provider": {
    /* local first */
    "ollama": { "options": { "baseURL": "http://localhost:11434/v1", }, },
  },
}
`;

// A missing comma between members. The parser stops at the second key, which
// starts at line 4, column 3 (1-based, counted by hand).
const BROKEN = `{
  // local models
  "model": "ollama/some-model"
  "provider": {}
}
`;

let tmpDir = '';
const CREATED: string[] = [];

async function setup(text: string): Promise<{
  env: Record<string, string>;
  cfgPath: string;
  cwd: string;
}> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-oc-e2e-'));
  const xdg = join(tmpDir, 'xdg');
  const cfgPath = join(xdg, 'opencode', 'opencode.jsonc');
  await mkdir(join(xdg, 'opencode'), { recursive: true });
  await writeFile(cfgPath, text, 'utf8');
  const cwd = join(tmpDir, 'cwd');
  await mkdir(cwd, { recursive: true });
  return {
    env: { UMBEL_STATE: tmpDir, XDG_CONFIG_HOME: xdg, UMBEL_CLAUDE_BIN: FAKE_OPENCODE },
    cfgPath,
    cwd,
  };
}

function sessionName(suffix: string): string {
  const name = `e${RUN_ID}${suffix}`;
  CREATED.push(name);
  return name;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
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

function spawnArgs(name: string, cwd: string, model?: string): string[] {
  const args = ['spawn', '--provider', 'opencode', '--name', name, '--cwd', cwd];
  return model === undefined ? args : [...args, '--model', model];
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

describe('umbel spawn --provider opencode and the user opencode.jsonc (umbel#53)', () => {
  test('the issue Case A config keeps every key and comment and gains the plugin entry', async () => {
    const { env, cfgPath, cwd } = await setup(CASE_A);
    const name = sessionName('a');

    const r = await runCli(spawnArgs(name, cwd, 'ollama/some-model'), env);

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(await hasSession(name, env)).toBe(true);

    const after = await readFile(cfgPath, 'utf8');
    // Every original line except the plugin array, which gains an entry,
    // survives byte for byte and in order.
    const kept = CASE_A.split('\n').filter((l) => !l.includes('"plugin"'));
    let from = 0;
    for (const line of kept) {
      const at = after.indexOf(line, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + line.length;
    }
    expect(after).toContain('// this comment is legal JSONC and accepted by opencode');

    const cfg = parse(after) as {
      $schema: string;
      plugin: string[];
      provider: { ollama: { models: Record<string, unknown>; options: { baseURL: string } } };
    };
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.plugin).toEqual([
      '~/.umbel/hooks/opencode-stop.ts',
      join(tmpDir, 'hooks', 'opencode-stop.ts'),
    ]);
    expect(Object.keys(cfg.provider.ollama.models)).toEqual(['some-model']);
    expect(cfg.provider.ollama.options.baseURL).toBe('http://localhost:11434/v1');
  });

  test('a config that does not parse exits 1 naming file:line:column and stays byte-identical', async () => {
    const { env, cfgPath, cwd } = await setup(BROKEN);
    const before = await readFile(cfgPath);
    const name = sessionName('b');

    const r = await runCli(spawnArgs(name, cwd), env);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${cfgPath}:4:3`);
    expect((await readFile(cfgPath)).equals(before)).toBe(true);
    expect(await hasSession(name, env)).toBe(false);
    expect(await exists(join(tmpDir, 'sessions', name))).toBe(false);
  });

  test('a model opencode does not list exits 2 naming the model, with no session', async () => {
    const { env, cfgPath, cwd } = await setup(CASE_A);
    const before = await readFile(cfgPath);
    const name = sessionName('c');

    const r = await runCli(spawnArgs(name, cwd, 'nobody/nothing'), env);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('nobody/nothing');
    expect(await hasSession(name, env)).toBe(false);
    const ls = await runCli(['ls'], env);
    expect(ls.code).toBe(0);
    expect(ls.stdout).not.toContain(name);
    // Refused before the plugin install, so the config is not touched either.
    expect((await readFile(cfgPath)).equals(before)).toBe(true);
  });

  test('block comments and trailing commas survive, and a second spawn does not write the file', async () => {
    const { env, cfgPath, cwd } = await setup(COMMENTED);

    const first = await runCli(spawnArgs(sessionName('e'), cwd), env);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);

    const afterFirst = await readFile(cfgPath, 'utf8');
    for (const line of COMMENTED.split('\n').filter((l) => !l.includes('"plugin"'))) {
      expect(afterFirst).toContain(line);
    }
    const cfg = parse(afterFirst, [], { allowTrailingComma: true }) as { plugin: string[] };
    expect(cfg.plugin).toEqual(['npm-plugin', join(tmpDir, 'hooks', 'opencode-stop.ts')]);

    // Pushed into the past so any write, however quick, moves it.
    const past = new Date(Date.now() - 60_000);
    await utimes(cfgPath, past, past);
    const mtimeBefore = (await stat(cfgPath)).mtimeMs;

    const second = await runCli(spawnArgs(sessionName('f'), cwd), env);
    expect(second.stderr).toBe('');
    expect(second.code).toBe(0);
    expect(await readFile(cfgPath, 'utf8')).toBe(afterFirst);
    expect((await stat(cfgPath)).mtimeMs).toBe(mtimeBefore);
  });

  test('a model opencode lists spawns the worker', async () => {
    const { env, cwd } = await setup(CASE_A);
    const name = sessionName('d');

    const r = await runCli(spawnArgs(name, cwd, 'opencode/big-pickle'), env);

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(await hasSession(name, env)).toBe(true);
    const ls = await runCli(['ls'], env);
    expect(ls.stdout).toContain(name);
  });
});
