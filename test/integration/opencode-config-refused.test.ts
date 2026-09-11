/**
 * An opencode.jsonc that does not parse refuses the spawn (umbel#53).
 *
 * The user's config is theirs: umbel must never replace it with a fresh one.
 * The refusal names the file, line and column, leaves the bytes untouched, and
 * happens before tmux or the session dir is touched. Drives the real hooks
 * adapter, the real spawn operation and the real CLI face against
 * fake-opencode.sh; XDG_CONFIG_HOME and UMBEL_STATE live under a tmp dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGlobalPlugin } from '../../src/adapters/hooks.ts';
import { hasSession, killSession } from '../../src/adapters/tmux.ts';
import { OpencodeConfigUnparsableError } from '../../src/core/errors.ts';
import { getProvider } from '../../src/core/providers/registry.ts';
import { runCli } from '../../src/faces/cli.ts';
import { spawn } from '../../src/operations/spawn.ts';

const RUN_ID = randomBytes(4).toString('hex');
const FAKE_OPENCODE = join(import.meta.dir, '../fixtures/fake-opencode.sh');

// Each case carries its own hand-computed position (1-based line and column),
// so the assertion does not trust the parser it is checking.
const BROKEN_CONFIGS = [
  {
    label: 'a stray comma before a key',
    text: '// my config\n{\n  "provider": { "ollama": {} },\n  , "model": "ollama/qwen"\n}\n',
    line: 4,
    column: 3,
  },
  {
    label: 'an unclosed object',
    text: '{\n  // unclosed\n  "model": "ollama/qwen",\n  "provider": {}\n',
    line: 5,
    column: 1,
  },
] as const;

let tmpDir = '';
const CREATED: string[] = [];

async function setup(
  text: string,
): Promise<{ env: Record<string, string | undefined>; cfgPath: string; cwd: string }> {
  tmpDir = await mkdtemp(join(tmpdir(), 'umbel-oc-refused-'));
  const xdg = join(tmpDir, 'xdg');
  const cfgPath = join(xdg, 'opencode', 'opencode.jsonc');
  await mkdir(join(xdg, 'opencode'), { recursive: true });
  await writeFile(cfgPath, text, 'utf8');
  const cwd = join(tmpDir, 'cwd');
  await mkdir(cwd, { recursive: true });
  return { env: { UMBEL_STATE: tmpDir, XDG_CONFIG_HOME: xdg }, cfgPath, cwd };
}

function sessionName(suffix: string): string {
  const name = `r${RUN_ID}${suffix}`;
  CREATED.push(name);
  return name;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
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

describe('opencode.jsonc that does not parse', () => {
  for (const broken of BROKEN_CONFIGS) {
    test(`installGlobalPlugin refuses ${broken.label} and leaves the file byte-identical`, async () => {
      const { env, cfgPath } = await setup(broken.text);
      const before = await readFile(cfgPath);
      const plugin = getProvider('opencode').globalPlugin;
      if (plugin === undefined) throw new Error('opencode provider declares no globalPlugin');

      const err = await installGlobalPlugin(plugin, env).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(OpencodeConfigUnparsableError);
      const refused = err as OpencodeConfigUnparsableError;
      expect(refused.file).toBe(cfgPath);
      expect(refused.line).toBe(broken.line);
      expect(refused.column).toBe(broken.column);
      expect(refused.message).toContain(`${cfgPath}:${broken.line}:${broken.column}`);
      expect((await readFile(cfgPath)).equals(before)).toBe(true);
    });

    test(`spawn refuses ${broken.label} before any tmux session or session dir exists`, async () => {
      const { env, cfgPath, cwd } = await setup(broken.text);
      const before = await readFile(cfgPath);
      const name = sessionName('s');

      const err = await spawn({
        provider: 'opencode',
        claudeBin: FAKE_OPENCODE,
        cwd,
        env,
        name,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(OpencodeConfigUnparsableError);
      expect((err as Error).message).toContain(`${cfgPath}:${broken.line}:${broken.column}`);
      expect(await hasSession(name, env)).toBe(false);
      // The plugin install precedes ensureSessionDir, so the dir is never made.
      expect(await exists(join(tmpDir, 'sessions', name))).toBe(false);
      expect((await readFile(cfgPath)).equals(before)).toBe(true);
    });
  }

  test('umbel spawn exits 1 with one line naming file:line:column and what to do', async () => {
    const broken = BROKEN_CONFIGS[0];
    const { env, cfgPath, cwd } = await setup(broken.text);
    const before = await readFile(cfgPath);
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
      code = await runCli(['spawn', '--provider', 'opencode', '--name', name, '--cwd', cwd]);
    } finally {
      process.stderr.write = origWrite;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    const out = stderr.join('');
    expect(code).toBe(1);
    expect(out.trimEnd().split('\n')).toHaveLength(1);
    expect(out).toContain(`${cfgPath}:${broken.line}:${broken.column}`);
    expect(out).toMatch(/fix/i);
    expect(out).toMatch(/move it aside/i);
    expect(await hasSession(name, env)).toBe(false);
    expect((await readFile(cfgPath)).equals(before)).toBe(true);
  });
});
