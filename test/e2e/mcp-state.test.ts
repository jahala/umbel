import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureSessionDir, writeMeta } from '../../src/adapters/fs-state.ts';
import { SessionSchema } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// umbel#98: `umbel mcp` gave its tools an empty environment, so a server
// started with UMBEL_STATE worked on ~/.umbel instead. A conductor's wait on a
// worker it had just spawned found no such session and reported it dead.
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');
let tmpDir = '';

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('umbel mcp', () => {
  test('works in the state root it is started with', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'umbel-mcp-state-'));
    const env = { UMBEL_STATE: tmpDir };
    const name = `mcpstate${Date.now().toString(36)}`;
    // A worker recorded in this state root and nowhere else.
    await ensureSessionDir(name, env);
    await writeMeta(
      name,
      SessionSchema.parse({
        name,
        cwd: '/tmp',
        anonymous: false,
        createdAt: Date.now(),
        jsonlPath: null,
      }),
      env,
    );

    const client = new Client({ name: 'mcp-state-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: 'bun',
        args: ['run', MAIN, 'mcp'],
        env: { ...(process.env as Record<string, string>), UMBEL_STATE: tmpDir },
      }),
    );
    try {
      const result = await client.callTool({ name: 'umbel_ls', arguments: {} });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '[]';
      const names = (JSON.parse(text) as Array<{ name: string }>).map((e) => e.name);
      expect(names).toContain(name);
    } finally {
      await client.close();
    }
  }, 30_000);
});
