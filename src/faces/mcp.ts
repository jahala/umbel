import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getProvider } from '../core/providers/registry.ts';
import { defaultDeps } from '../operations/deps.ts';
import type { Deps } from '../operations/deps.ts';
import { kill } from '../operations/kill.ts';
import { send } from '../operations/send.ts';
import { spawn } from '../operations/spawn.ts';
import { status } from '../operations/status.ts';
import { waitFor } from '../operations/wait.ts';
import { VerbSchemas } from './verbs.ts';

// ---------------------------------------------------------------------------
// McpToolOpts — context injected into tool handlers
// ---------------------------------------------------------------------------

export interface McpServerOpts {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  deps?: Partial<Deps>;
}

// ---------------------------------------------------------------------------
// Tool handler result type (matches MCP SDK expectations)
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

// ---------------------------------------------------------------------------
// createMcpTools — returns callable handler functions keyed by tool name.
// Extracted so integration tests can call handlers directly without stdio.
// runMcpServer delegates to these — no logic duplication.
// ---------------------------------------------------------------------------

// Optional fields use `| undefined` explicitly to match zod's ShapeOutput
// under our exactOptionalPropertyTypes tsconfig. The MCP SDK's tool callback
// signature derives args from the zod schema, which produces fields as
// optional-or-undefined; without the explicit undefined here the handlers
// don't satisfy the SDK's overload.
export interface McpToolHandlers {
  rctrl_spawn: (args: {
    name?: string | undefined;
    cwd: string;
    provider?: 'claude' | 'codex' | 'gemini' | undefined;
    model?: string | undefined;
    allowedTools?: string | undefined;
  }) => Promise<ToolResult>;
  rctrl_send: (args: { name: string; prompt: string }) => Promise<ToolResult>;
  rctrl_wait: (args: {
    name: string;
    until: 'stop' | 'file' | 'pattern';
    file?: string | undefined;
    pattern?: string | undefined;
    timeout?: string | undefined;
  }) => Promise<ToolResult>;
  rctrl_status: (args: { name?: string | undefined }) => Promise<ToolResult>;
  rctrl_ls: (args: Record<string, never>) => Promise<ToolResult>;
  rctrl_kill: (args: { name: string; keepState: boolean }) => Promise<ToolResult>;
  rctrl_read: (args: { name: string }) => Promise<ToolResult>;
  rctrl_capture: (args: { name: string; lines: number }) => Promise<ToolResult>;
  rctrl_logs: (args: { name: string }) => Promise<ToolResult>;
}

export function createMcpTools(opts: McpServerOpts): McpToolHandlers {
  const env = opts.env ?? {};
  const deps = opts.deps;
  const d = { ...defaultDeps, ...deps };

  return {
    rctrl_spawn: async (args) => {
      const spawnOpts = {
        cwd: args.cwd,
        env,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.allowedTools !== undefined ? { allowedTools: args.allowedTools } : {}),
        ...(deps !== undefined ? { deps } : {}),
      };
      const result = await spawn(spawnOpts);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ name: result.session.name }) }],
      };
    },

    rctrl_send: async (args) => {
      const sendOpts = {
        name: args.name,
        prompt: args.prompt,
        env,
        ...(deps !== undefined ? { deps } : {}),
      };
      const result = await send(sendOpts);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ sinceMtime: result.sinceMtime }) },
        ],
      };
    },

    rctrl_wait: async (args) => {
      const waitOpts = {
        name: args.name,
        env,
        ...(deps !== undefined ? { deps } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      };
      const result = await waitFor(waitOpts);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ reason: result.reason }) }],
      };
    },

    rctrl_status: async (args) => {
      const statusOpts = {
        env,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(deps !== undefined ? { deps } : {}),
      };
      const entries = await status(statusOpts);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(entries) }],
      };
    },

    rctrl_ls: async (_args) => {
      const entries = await status({ env, ...(deps !== undefined ? { deps } : {}) });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(entries) }],
      };
    },

    rctrl_kill: async (args) => {
      const killOpts = {
        name: args.name,
        removeState: !args.keepState,
        env,
        ...(deps !== undefined ? { deps } : {}),
      };
      await kill(killOpts);
      return { content: [{ type: 'text' as const, text: 'killed' }] };
    },

    rctrl_read: async (args) => {
      const session = await d.fs.readMeta(args.name, env);
      const jsonlPath = session.jsonlPath;
      if (jsonlPath === null) {
        return { content: [{ type: 'text' as const, text: '' }] };
      }
      const provider = getProvider(session.provider);
      const content = await Bun.file(jsonlPath).text();
      const text = provider.parseTranscript(content);
      return { content: [{ type: 'text' as const, text }] };
    },

    rctrl_capture: async (args) => {
      const text = await d.tmux.capturePane(args.name, args.lines);
      return { content: [{ type: 'text' as const, text }] };
    },

    rctrl_logs: async (args) => {
      const logPath = `${d.fs.eventsDir(args.name, env)}/log`;
      let content = '';
      try {
        content = await Bun.file(logPath).text();
      } catch {
        content = '';
      }
      return { content: [{ type: 'text' as const, text: content }] };
    },
  };
}

// ---------------------------------------------------------------------------
// runMcpServer — entry point; delegates to createMcpTools + stdio transport
// ---------------------------------------------------------------------------

export async function runMcpServer(opts: McpServerOpts): Promise<void> {
  const tools = createMcpTools(opts);

  const server = new McpServer(
    { name: 'rctrl', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.tool(
    'rctrl_spawn',
    'Spawn a new rctrl session running claude',
    VerbSchemas.spawn.shape,
    tools.rctrl_spawn,
  );
  server.tool(
    'rctrl_send',
    'Send a prompt to a running rctrl session',
    VerbSchemas.send.shape,
    tools.rctrl_send,
  );
  server.tool(
    'rctrl_wait',
    'Wait for a session to complete a turn',
    VerbSchemas.wait.shape,
    tools.rctrl_wait,
  );
  server.tool(
    'rctrl_status',
    'Get status of one or all sessions',
    VerbSchemas.status.shape,
    tools.rctrl_status,
  );
  server.tool('rctrl_ls', 'List all rctrl sessions', VerbSchemas.ls.shape, tools.rctrl_ls);
  server.tool(
    'rctrl_kill',
    'Kill a session and optionally remove state',
    VerbSchemas.kill.shape,
    tools.rctrl_kill,
  );
  server.tool(
    'rctrl_read',
    'Read the last assistant message from a session',
    VerbSchemas.read.shape,
    tools.rctrl_read,
  );
  server.tool(
    'rctrl_capture',
    'Capture last N lines from the tmux pane',
    VerbSchemas.capture.shape,
    tools.rctrl_capture,
  );
  server.tool(
    'rctrl_logs',
    'Read session event log (non-follow)',
    { name: z.string() },
    tools.rctrl_logs,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Block until signal fires
  await new Promise<void>((resolve) => {
    if (opts.signal !== undefined) {
      opts.signal.addEventListener('abort', () => resolve());
    }
    // stdin close is handled by StdioServerTransport
  });
}
