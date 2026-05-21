import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { defaultDeps } from '../operations/deps.ts';
import type { Deps } from '../operations/deps.ts';
import { kill } from '../operations/kill.ts';
import { send } from '../operations/send.ts';
import { spawn } from '../operations/spawn.ts';
import { status } from '../operations/status.ts';
import { waitFor } from '../operations/wait.ts';
import { VerbSchemas } from './verbs.ts';

// ---------------------------------------------------------------------------
// runMcpServer
// ---------------------------------------------------------------------------

export interface McpServerOpts {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  deps?: Partial<Deps>;
}

export async function runMcpServer(opts: McpServerOpts): Promise<void> {
  const env = opts.env ?? {};
  const deps = opts.deps;
  const d = { ...defaultDeps, ...deps };

  const server = new McpServer(
    { name: 'rctrl', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  // rctrl_spawn
  server.tool(
    'rctrl_spawn',
    'Spawn a new rctrl session running claude',
    VerbSchemas.spawn.shape,
    async (args) => {
      const spawnOpts = {
        cwd: args.cwd,
        env,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.allowedTools !== undefined ? { allowedTools: args.allowedTools } : {}),
        ...(deps !== undefined ? { deps } : {}),
      };
      const result = await spawn(spawnOpts);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ name: result.session.name }) }],
      };
    },
  );

  // rctrl_send
  server.tool(
    'rctrl_send',
    'Send a prompt to a running rctrl session',
    VerbSchemas.send.shape,
    async (args) => {
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
  );

  // rctrl_wait
  server.tool(
    'rctrl_wait',
    'Wait for a session to complete a turn',
    VerbSchemas.wait.shape,
    async (args) => {
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
  );

  // rctrl_status
  server.tool(
    'rctrl_status',
    'Get status of one or all sessions',
    VerbSchemas.status.shape,
    async (args) => {
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
  );

  // rctrl_ls
  server.tool('rctrl_ls', 'List all rctrl sessions', VerbSchemas.ls.shape, async () => {
    const entries = await status({ env, ...(deps !== undefined ? { deps } : {}) });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(entries) }],
    };
  });

  // rctrl_kill
  server.tool(
    'rctrl_kill',
    'Kill a session and optionally remove state',
    VerbSchemas.kill.shape,
    async (args) => {
      const killOpts = {
        name: args.name,
        removeState: !args.keepState,
        env,
        ...(deps !== undefined ? { deps } : {}),
      };
      await kill(killOpts);
      return { content: [{ type: 'text' as const, text: 'killed' }] };
    },
  );

  // rctrl_read
  server.tool(
    'rctrl_read',
    'Read the last assistant message from a session',
    VerbSchemas.read.shape,
    async (args) => {
      const session = await d.fs.readMeta(args.name, env);
      const jsonlPath = session.jsonlPath;
      if (jsonlPath === null) {
        return { content: [{ type: 'text' as const, text: '' }] };
      }
      const text = await d.jsonl.lastAssistantMessage({ jsonlPath });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // rctrl_capture
  server.tool(
    'rctrl_capture',
    'Capture last N lines from the tmux pane',
    VerbSchemas.capture.shape,
    async (args) => {
      const text = await d.tmux.capturePane(args.name, args.lines);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // rctrl_logs (non-follow only)
  server.tool(
    'rctrl_logs',
    'Read session event log (non-follow)',
    { name: z.string() },
    async (args) => {
      const logPath = `${d.fs.eventsDir(args.name, env)}/log`;
      let content = '';
      try {
        content = await Bun.file(logPath).text();
      } catch {
        content = '';
      }
      return { content: [{ type: 'text' as const, text: content }] };
    },
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
