/**
 * One umbel plugin, whatever the state root (umbel#124).
 *
 * Older umbels wrote <UMBEL_STATE>/hooks/opencode-stop.ts and registered its
 * path in the user's opencode.jsonc, so every state root left an entry behind.
 * opencode 1.18.18 loads plugin files from $XDG_CONFIG_HOME/opencode/plugin/,
 * so the plugin now lives there under one fixed name, and spawn removes the
 * entries an older umbel added. Drives the real spawn operation against
 * fake-opencode.sh; XDG_CONFIG_HOME and UMBEL_STATE live under a tmp dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSession } from '../../src/adapters/tmux.ts';
import { PLUGIN_SOURCE } from '../../src/core/providers/opencode.ts';
import { spawn } from '../../src/operations/spawn.ts';

const RUN_ID = randomBytes(4).toString('hex');
const FAKE_OPENCODE = join(import.meta.dir, '../fixtures/fake-opencode.sh');
const PLUGIN_FILE = 'opencode-stop.ts';
const USER_PLUGIN = '/home/user/.config/opencode/my-plugin.ts';
const LEGACY_A = '/tmp/umbel-review116.abc/hooks/opencode-stop.ts';
const LEGACY_B = '/tmp/umbel-control116.def/hooks/opencode-stop.ts';

const TWO_LEGACY = `{
  "$schema": "https://opencode.ai/config.json",
  // two throwaway state roots left these behind (umbel#124)
  "plugin": [
    "${LEGACY_A}",
    "${USER_PLUGIN}",
    "${LEGACY_B}",
  ],
  "provider": {
    "ollama": { "options": { "baseURL": "http://localhost:11434/v1" } },
  },
}
`;

let tmpDir = '';
const CREATED: { name: string; state: string }[] = [];

async function setup(text: string | null): Promise<{
  xdg: string;
  stateA: string;
  stateB: string;
  cfgPath: string;
  pluginPath: string;
  cwd: string;
}> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-oc-single-'));
  const xdg = join(tmpDir, 'xdg');
  const cfgPath = join(xdg, 'opencode', 'opencode.jsonc');
  if (text !== null) {
    await mkdir(join(xdg, 'opencode'), { recursive: true });
    await writeFile(cfgPath, text, 'utf8');
  }
  const cwd = join(tmpDir, 'cwd');
  await mkdir(cwd, { recursive: true });
  return {
    xdg,
    stateA: join(tmpDir, 'state-a'),
    stateB: join(tmpDir, 'state-b'),
    cfgPath,
    pluginPath: join(xdg, 'opencode', 'plugin', PLUGIN_FILE),
    cwd,
  };
}

function sessionName(suffix: string): string {
  return `i${RUN_ID}${suffix}`;
}

async function spawnOpencode(
  env: Record<string, string | undefined>,
  cwd: string,
  name: string,
): Promise<void> {
  CREATED.push({ name, state: env.UMBEL_STATE ?? '' });
  await spawn({ provider: 'opencode', claudeBin: FAKE_OPENCODE, cwd, env, name });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function backdate(path: string): Promise<number> {
  const past = new Date(Date.now() - 60_000);
  await utimes(path, past, past);
  return (await stat(path)).mtimeMs;
}

afterEach(async () => {
  await Promise.all(
    CREATED.splice(0).map(({ name, state }) =>
      killSession(name, { UMBEL_STATE: state }).catch(() => undefined),
    ),
  );
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('the umbel opencode plugin across state roots', () => {
  test('a config with two legacy entries loses only those, and the plugin lands once', async () => {
    const { xdg, stateA, cfgPath, pluginPath, cwd } = await setup(TWO_LEGACY);

    await spawnOpencode({ UMBEL_STATE: stateA, XDG_CONFIG_HOME: xdg }, cwd, sessionName('a'));

    const after = await readFile(cfgPath, 'utf8');
    expect(after).not.toContain(LEGACY_A);
    expect(after).not.toContain(LEGACY_B);
    expect(after).toContain('// two throwaway state roots left these behind (umbel#124)');
    expect(after).toContain(USER_PLUGIN);
    expect((Bun.JSONC.parse(after) as { plugin: string[] }).plugin).toEqual([USER_PLUGIN]);

    expect(await readdir(join(xdg, 'opencode', 'plugin'))).toEqual([PLUGIN_FILE]);
    expect(await readFile(pluginPath, 'utf8')).toBe(PLUGIN_SOURCE);
    expect(await exists(join(stateA, 'hooks', PLUGIN_FILE))).toBe(false);
  });

  test('a second spawn under another state root adds no file and does not write the config', async () => {
    const { xdg, stateA, stateB, cfgPath, cwd } = await setup(TWO_LEGACY);
    await spawnOpencode({ UMBEL_STATE: stateA, XDG_CONFIG_HOME: xdg }, cwd, sessionName('b1'));
    const before = await readFile(cfgPath);
    const mtimeBefore = await backdate(cfgPath);

    await spawnOpencode({ UMBEL_STATE: stateB, XDG_CONFIG_HOME: xdg }, cwd, sessionName('b2'));

    expect((await readFile(cfgPath)).equals(before)).toBe(true);
    expect((await stat(cfgPath)).mtimeMs).toBe(mtimeBefore);
    expect(await readdir(join(xdg, 'opencode', 'plugin'))).toEqual([PLUGIN_FILE]);
  });

  test('a config with nothing to remove is never written', async () => {
    const existing = `{
  // mine
  "plugin": [
    "${USER_PLUGIN}",
  ],
}
`;
    const { xdg, stateA, cfgPath, pluginPath, cwd } = await setup(existing);
    const mtimeBefore = await backdate(cfgPath);

    await spawnOpencode({ UMBEL_STATE: stateA, XDG_CONFIG_HOME: xdg }, cwd, sessionName('c'));

    expect(await readFile(cfgPath, 'utf8')).toBe(existing);
    expect((await stat(cfgPath)).mtimeMs).toBe(mtimeBefore);
    expect(await readFile(pluginPath, 'utf8')).toBe(PLUGIN_SOURCE);
  });

  test('a plugin written by an older umbel is replaced', async () => {
    const { xdg, stateA, pluginPath, cwd } = await setup(null);
    await mkdir(join(xdg, 'opencode', 'plugin'), { recursive: true });
    await writeFile(pluginPath, '// an older umbel, without the session guard\n', 'utf8');

    await spawnOpencode({ UMBEL_STATE: stateA, XDG_CONFIG_HOME: xdg }, cwd, sessionName('d'));

    expect(await readFile(pluginPath, 'utf8')).toBe(PLUGIN_SOURCE);
  });

  test('with no config, spawn writes the plugin and creates no opencode.jsonc', async () => {
    const { xdg, stateA, cfgPath, pluginPath, cwd } = await setup(null);

    await spawnOpencode({ UMBEL_STATE: stateA, XDG_CONFIG_HOME: xdg }, cwd, sessionName('e'));

    expect(await readFile(pluginPath, 'utf8')).toBe(PLUGIN_SOURCE);
    expect(await exists(cfgPath)).toBe(false);
  });
});
