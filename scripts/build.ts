#!/usr/bin/env bun
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const ENTRY = join(ROOT, 'src', 'main.ts');

interface Target {
  readonly name: string;
  readonly target: string;
}

const TARGETS = {
  'darwin-arm64': { name: 'rctrl-darwin-arm64', target: 'bun-darwin-arm64' },
  'darwin-x64': { name: 'rctrl-darwin-x64', target: 'bun-darwin-x64' },
  'linux-x64': { name: 'rctrl-linux-x64', target: 'bun-linux-x64' },
  'linux-arm64': { name: 'rctrl-linux-arm64', target: 'bun-linux-arm64' },
} as const satisfies Record<string, Target>;

async function main(): Promise<void> {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const all = process.argv.includes('--all');
  const targets: readonly Target[] = all ? Object.values(TARGETS) : [pickCurrent()];

  for (const t of targets) {
    const outFile = join(DIST, t.name);
    process.stderr.write(`building ${t.name}…\n`);
    const proc = Bun.spawn(
      [
        'bun',
        'build',
        '--compile',
        `--target=${t.target}`,
        '--minify',
        '--sourcemap',
        ENTRY,
        '--outfile',
        outFile,
      ],
      { stdout: 'inherit', stderr: 'inherit' },
    );
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`build failed for ${t.name} (exit ${code})`);
    }
  }

  const localLink = join(DIST, 'rctrl');
  const current = pickCurrent();
  const currentBin = join(DIST, current.name);
  await Bun.write(localLink, Bun.file(currentBin));
  await Bun.spawn(['chmod', '+x', localLink]).exited;
  process.stderr.write(`\ndist/rctrl → ${current.name} (use --all for all targets)\n`);

  if (process.argv.includes('--install')) {
    const dest = installDest();
    await installBinary(localLink, dest);
    // A non-running install (bad signature, perms, partial write) is a failure,
    // not a success — exec the result and require a clean run.
    const check = Bun.spawn([dest, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([new Response(check.stdout).text(), check.exited]);
    if (code !== 0 || out.trim() === '') {
      throw new Error(`installed binary at ${dest} did not run (exit ${code})`);
    }
    process.stderr.write(`installed → ${dest}  (${out.trim()})\n`);
  }
}

function pickCurrent(): Target {
  const key = `${process.platform}-${process.arch}` as keyof typeof TARGETS;
  const t = TARGETS[key];
  if (t === undefined) {
    throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
  }
  return t;
}

// Install the built binary into a bin dir. macOS-safe: replacing a code-signed
// binary IN PLACE invalidates the kernel's cached signature, so the new file gets
// Killed: 9 on exec. We write to a temp path on the same filesystem and atomically
// rename() it over the destination — a fresh inode every time.
export async function installBinary(srcPath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp-${process.pid}`;
  await Bun.write(tmp, Bun.file(srcPath));
  await chmod(tmp, 0o755);
  await rename(tmp, destPath);
}

function installDest(): string {
  const dir = process.env.RCTRL_INSTALL_DIR ?? join(homedir(), '.local', 'bin');
  return join(dir, 'rctrl');
}

if (import.meta.main) {
  await main();
}
