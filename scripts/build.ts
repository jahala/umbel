#!/usr/bin/env bun
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

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
}

function pickCurrent(): Target {
  const key = `${process.platform}-${process.arch}` as keyof typeof TARGETS;
  const t = TARGETS[key];
  if (t === undefined) {
    throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
  }
  return t;
}

await main();
