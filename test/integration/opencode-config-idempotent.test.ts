/**
 * A spawn that finds its plugin already registered leaves opencode.jsonc alone
 * (umbel#53). The first spawn on the issue's commented Case A config adds the
 * plugin entry and keeps every original line; every later spawn must not write
 * the file at all, so its bytes and its mtime stay put. The mtime is pushed a
 * minute into the past before the later spawn so any rewrite, even one with
 * identical bytes, moves it. Drives the real spawn operation against
 * fake-opencode.sh; XDG_CONFIG_HOME and UMBEL_STATE live under a tmp dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';
import { spawn } from '../../src/operations/spawn.ts';

const RUN_ID = randomBytes(4).toString('hex');
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

let tmpDir = '';
const CREATED: string[] = [];

async function setup(
  text: string | null,
): Promise<{ env: Record<string, string | undefined>; cfgPath: string; cwd: string }> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-oc-idem-'));
  const xdg = join(tmpDir, 'xdg');
  const cfgPath = join(xdg, 'opencode', 'opencode.jsonc');
  if (text !== null) {
    await mkdir(join(xdg, 'opencode'), { recursive: true });
    await writeFile(cfgPath, text, 'utf8');
  }
  const cwd = join(tmpDir, 'cwd');
  await mkdir(cwd, { recursive: true });
  return { env: { UMBEL_STATE: tmpDir, XDG_CONFIG_HOME: xdg }, cfgPath, cwd };
}

function sessionName(suffix: string): string {
  const name = `i${RUN_ID}${suffix}`;
  CREATED.push(name);
  return name;
}

async function spawnOpencode(
  env: Record<string, string | undefined>,
  cwd: string,
  name: string,
): Promise<void> {
  await spawn({ provider: 'opencode', claudeBin: FAKE_OPENCODE, cwd, env, name });
}

async function backdate(path: string): Promise<number> {
  const past = new Date(Date.now() - 60_000);
  await utimes(path, past, past);
  return (await stat(path)).mtimeMs;
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

describe('opencode.jsonc across repeated spawns', () => {
  test('a first spawn on the commented Case A config keeps every original line and adds the plugin', async () => {
    const { env, cfgPath, cwd } = await setup(CASE_A);

    await spawnOpencode(env, cwd, sessionName('a'));

    const after = await readFile(cfgPath, 'utf8');
    for (const line of CASE_A.split('\n')) {
      if (line.includes('"plugin"')) continue;
      expect(after).toContain(line);
    }
    expect(after).toContain('"~/.umbel/hooks/opencode-stop.ts"');
    expect(after).toContain(JSON.stringify(join(tmpDir, 'hooks', 'opencode-stop.ts')));
  });

  test('a second spawn leaves the commented config byte-identical and never writes it', async () => {
    const { env, cfgPath, cwd } = await setup(CASE_A);
    await spawnOpencode(env, cwd, sessionName('b1'));
    const before = await readFile(cfgPath);
    const mtimeBefore = await backdate(cfgPath);

    await spawnOpencode(env, cwd, sessionName('b2'));

    expect((await readFile(cfgPath)).equals(before)).toBe(true);
    expect((await stat(cfgPath)).mtimeMs).toBe(mtimeBefore);
  });

  // opencode (1.18.18) rewrites any config it loads that lacks "$schema",
  // splicing the key in after the opening brace. A created file without it
  // would be rewritten by the very worker this spawn launches.
  test('with no config, the first spawn creates one opencode loads without rewriting, and the second never writes it', async () => {
    const { env, cfgPath, cwd } = await setup(null);
    await spawnOpencode(env, cwd, sessionName('c1'));
    const created = await readFile(cfgPath, 'utf8');
    expect(created).toContain(JSON.stringify(join(tmpDir, 'hooks', 'opencode-stop.ts')));
    expect((JSON.parse(created) as { $schema?: string }).$schema).toBe(
      'https://opencode.ai/config.json',
    );
    const mtimeBefore = await backdate(cfgPath);

    await spawnOpencode(env, cwd, sessionName('c2'));

    expect(await readFile(cfgPath, 'utf8')).toBe(created);
    expect((await stat(cfgPath)).mtimeMs).toBe(mtimeBefore);
  });
});
