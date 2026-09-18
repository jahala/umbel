import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession, socketFor } from '../../src/adapters/tmux.ts';
import { envExports } from '../../src/core/worker-env.ts';
import { spawn } from '../../src/operations/spawn.ts';

// ---------------------------------------------------------------------------
// umbel#93: no secret on any argv umbel creates, and only what a worker needs
// travels at all.
//
// spawn used to hand the whole environment to tmux as `new-session -e K=V`, so
// every value sat on the tmux client's argv, and on the server's for its whole
// life, since the server is forked from that client. A provider key leaked this
// way. These tests plant canaries and look for them everywhere.
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(
    CREATED.splice(0).map((n) => killSession(n, { UMBEL_STATE: tmpDir }).catch(() => undefined)),
  );
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

// Every process's command line, as the process table shows it to anyone.
const allArgv = (): Promise<string> => run(['ps', '-axww', '-o', 'args=']);

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

// What the worker received, from the fixture's probe: NAME=<sha256> or NAME=-.
// Read by hash so the value never lands in a file of its own.
function probed(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('worker environment (umbel#93)', () => {
  test('a withheld canary goes nowhere, and a passed one reaches only the worker', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-worker-env-'));
    const env = { UMBEL_STATE: tmpDir };
    const name = `t${RUN_ID}env`;
    // Outside the state dir, so the file sweep below does not read it; it holds
    // only hashes either way.
    const probeDir = await mkdtemp(join(tmpdir(), 'umbel-worker-env-probe-'));
    const probe = join(probeDir, 'probe');
    const withheld = `withheld-${randomBytes(12).toString('hex')}`;
    const passed = `passed-${randomBytes(12).toString('hex')}`;

    // Sample every command line from before the spawn until after it, so the
    // short-lived tmux client that used to carry `-e K=V` cannot slip past.
    const seen: string[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        seen.push(await allArgv());
        await Bun.sleep(25);
      }
    })();

    process.env.UMBEL_CANARY_WITHHELD = withheld;
    try {
      await spawn({
        name,
        cwd: '/tmp',
        claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
        env: {
          ...env,
          FAKE_CLAUDE_JSONL_DIR: join(tmpDir, 'projects', '-tmp'),
          FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
          FAKE_CLAUDE_ENV_PROBE: probe,
          FAKE_CLAUDE_ENV_PROBE_NAMES: 'UMBEL_CANARY_PASSED UMBEL_CANARY_WITHHELD',
        },
        workerEnv: { UMBEL_CANARY_PASSED: passed },
        deps: {
          jsonl: {
            ...jsonlAdapter,
            discoverSessionJsonl: (o) =>
              jsonlAdapter.discoverSessionJsonl({ ...o, projectsRoot: join(tmpDir, 'projects') }),
          },
        },
      });
      CREATED.push(name);
      await Bun.sleep(1_000);
    } finally {
      delete process.env.UMBEL_CANARY_WITHHELD;
      sampling = false;
      await sampler;
    }

    const argv = seen.join('\n');
    expect(argv.includes(withheld)).toBe(false);
    expect(argv.includes(passed)).toBe(false);

    // tmux reports its own environments: the server's global one, which every
    // pane starts from, and the session's, which `-e` used to fill.
    const socket = ['-L', socketFor(env)];
    const serverEnv = await run(['tmux', ...socket, 'show-environment', '-g']);
    const sessionEnv = await run(['tmux', ...socket, 'show-environment', '-t', `umbel-${name}`]);
    expect(serverEnv).toContain('PATH='); // the listing is real, not empty
    for (const tmuxEnv of [serverEnv, sessionEnv]) {
      expect(tmuxEnv.includes(withheld) || tmuxEnv.includes(passed)).toBe(false);
    }

    const worker = probed(probe);
    expect(worker.UMBEL_CANARY_PASSED).toBe(sha256(passed));
    expect(worker.UMBEL_CANARY_WITHHELD).toBe('-');
    await rm(probeDir, { recursive: true, force: true });

    for (const file of filesUnder(tmpDir)) {
      const text = readFileSync(file, 'utf8');
      expect({ file, leaks: text.includes(withheld) || text.includes(passed) }).toEqual({
        file,
        leaks: false,
      });
    }
  }, 30_000);

  test('the exports carry any value bash can hold, byte for byte', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-worker-env-'));
    const values = {
      QUOTE: "it's a 'quoted' value",
      DOLLAR: 'costs $5 and `$(rm -rf /)` stays inert',
      NEWLINE: 'line one\nline two',
      BACKSLASH: 'C:\\path\\to\\file',
      UNICODE: 'ä ö ü 漢字 ✓',
      EMPTY: '',
    };
    const file = join(tmpDir, 'env');
    await writeFile(file, envExports(values), { mode: 0o600 });

    const names = Object.keys(values);
    const out = await run([
      'bash',
      '-c',
      `. "$1"; for n in ${names.join(' ')}; do printf '%s\\0' "\${!n}"; done`,
      'bash',
      file,
    ]);
    expect(out.split('\0').slice(0, names.length)).toEqual(Object.values(values));
  });
});
