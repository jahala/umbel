import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from '../../src/faces/mcp.ts';

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

    // Collect stdout — need BOTH id=1 (initialize, for instructions) and id=2 (tools/list)
    let outputBuf = '';
    let initResponse: { id?: number; result?: { instructions?: string } } | undefined;
    let toolsListResponse:
      | { id?: number; result?: { tools?: Array<{ name: string; description?: string }> } }
      | undefined;

    const deadline = Date.now() + 10000;
    const textStream = new Response(proc.stdout).body;

    if (textStream !== null) {
      const reader = textStream.getReader();
      const decoder = new TextDecoder();

      while (
        (initResponse === undefined || toolsListResponse === undefined) &&
        Date.now() < deadline
      ) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500),
        );

        const { done, value } = await Promise.race([readPromise, timeoutPromise]);

        if (done) break;
        if (value !== undefined) {
          outputBuf += decoder.decode(value);
        }

        for (const line of outputBuf.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const parsed = JSON.parse(trimmed) as {
              id?: number;
              result?: {
                instructions?: string;
                tools?: Array<{ name: string; description?: string }>;
              };
            };
            if (parsed.id === 1 && parsed.result !== undefined) {
              initResponse = parsed;
            }
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
    expect(initResponse).toBeDefined();

    // InitializeResult carries the server-level instructions verbatim
    expect(initResponse?.result?.instructions).toBe(SERVER_INSTRUCTIONS);

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
      'rctrl_help',
    ];

    for (const expected of expectedTools) {
      expect(toolNames).toContain(expected);
    }

    // Each tool's description matches TOOL_DESCRIPTIONS — catches drift
    // between the constant and what's registered on the server.
    for (const t of tools) {
      const expected = (TOOL_DESCRIPTIONS as Record<string, string>)[t.name];
      if (expected !== undefined) {
        expect(t.description).toBe(expected);
      }
    }
  });

  test('SERVER_INSTRUCTIONS contains fork-decision and lifecycle markers', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(200);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1500);
    // Fork-decision is the load-bearing content; missing this means the
    // string drifted away from its purpose.
    expect(SERVER_INSTRUCTIONS).toContain('USE rctrl');
    expect(SERVER_INSTRUCTIONS).toContain("USE your host's subagent");
    expect(SERVER_INSTRUCTIONS).toContain('Lifecycle:');
    expect(SERVER_INSTRUCTIONS).toContain('rctrl_send does NOT wait');
    expect(SERVER_INSTRUCTIONS).toContain('rctrl_help');
  });

  test('TOOL_DESCRIPTIONS has an entry per registered tool, each non-empty and bounded', () => {
    const expected = [
      'rctrl_spawn',
      'rctrl_send',
      'rctrl_wait',
      'rctrl_status',
      'rctrl_ls',
      'rctrl_kill',
      'rctrl_read',
      'rctrl_capture',
      'rctrl_logs',
      'rctrl_help',
    ];
    for (const name of expected) {
      const desc = (TOOL_DESCRIPTIONS as Record<string, string | undefined>)[name];
      expect(desc).toBeTruthy();
      if (desc !== undefined) {
        expect(desc.length).toBeGreaterThan(20);
        expect(desc.length).toBeLessThan(200);
      }
    }
  });
});
