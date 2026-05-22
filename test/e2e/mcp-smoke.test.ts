import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// MCP smoke test — start rctrl mcp as subprocess, send tools/list, verify
// ---------------------------------------------------------------------------

const MAIN = join(import.meta.dir, '../../src/main.ts');

let tmpDir = '';

afterAll(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('mcp-smoke', () => {
  test('rctrl mcp exposes all expected tool names', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-mcp-smoke-'));

    const proc = Bun.spawn(['bun', 'run', MAIN, 'mcp'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, RCTRL_STATE: tmpDir },
    });

    // MCP JSON-RPC initialize + tools/list sequence
    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });

    const listMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    const writer = proc.stdin;
    writer.write(`${initMsg}\n`);
    writer.write(`${listMsg}\n`);

    // Collect stdout as a text stream until we find the tools/list response (id=2)
    let outputBuf = '';
    let toolsListResponse:
      | { id?: number; result?: { tools?: Array<{ name: string }> } }
      | undefined;

    const deadline = Date.now() + 10000;
    const textStream = new Response(proc.stdout).body;

    if (textStream !== null) {
      const reader = textStream.getReader();
      const decoder = new TextDecoder();

      while (toolsListResponse === undefined && Date.now() < deadline) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500),
        );

        const { done, value } = await Promise.race([readPromise, timeoutPromise]);

        if (done) break;
        if (value !== undefined) {
          outputBuf += decoder.decode(value);
        }

        // Parse each line for a JSON-RPC response with id=2
        for (const line of outputBuf.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const parsed = JSON.parse(trimmed) as {
              id?: number;
              result?: { tools?: Array<{ name: string }> };
            };
            if (parsed.id === 2 && parsed.result !== undefined) {
              toolsListResponse = parsed;
            }
          } catch {
            // not JSON yet
          }
        }
      }

      reader.cancel().catch(() => undefined);
    }

    proc.kill();

    expect(toolsListResponse).toBeDefined();

    const tools = toolsListResponse?.result?.tools ?? [];
    const toolNames = tools.map((t) => t.name);

    const expectedTools = [
      'rctrl_spawn',
      'rctrl_send',
      'rctrl_wait',
      'rctrl_status',
      'rctrl_ls',
      'rctrl_kill',
      'rctrl_read',
      'rctrl_capture',
      'rctrl_logs',
    ];

    for (const expected of expectedTools) {
      expect(toolNames).toContain(expected);
    }
  });
});
