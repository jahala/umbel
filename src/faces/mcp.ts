import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SessionDeadError } from '../core/errors.ts';
import { getProvider } from '../core/providers/registry.ts';
import { truncateAssistantText } from '../core/truncate.ts';
import { actions } from '../operations/actions.ts';
import type { Deps } from '../operations/deps.ts';
import { defaultDeps } from '../operations/deps.ts';
import { diff } from '../operations/diff.ts';
import { kill } from '../operations/kill.ts';
import { resolveTranscriptContent } from '../operations/resolve-transcript.ts';
import { send } from '../operations/send.ts';
import { spawn } from '../operations/spawn.ts';
import { status } from '../operations/status.ts';
import { waitFor } from '../operations/wait.ts';
import { HELP_TOPICS, type HelpTopic, helpForTopic } from './mcp-help.ts';
import { parseDuration, VerbSchemas } from './verbs.ts';

// ---------------------------------------------------------------------------
// Agent-facing copy. Exported so tests can snapshot the strings.
// ---------------------------------------------------------------------------

// Always-on context the MCP client renders into the agent's system prompt.
// Kept tight — fork-decision (when to use umbel vs the host's own subagent)
// plus the lifecycle one-liner. Deeper docs go behind umbel_help.
export const SERVER_INSTRUCTIONS = `umbel drives interactive agent CLIs (Claude Code, Codex, Gemini, OpenCode) in tmux — subscription-billed for claude/codex/gemini, bring-any-model (local/free/key) for opencode.

USE umbel when you need: a persistent worker across many turns (review→fix→verify); a different provider than yourself (e.g., you're Claude but want Codex); parallel workers in separate cwds (git worktrees); granular send/wait/read control.

USE your host's subagent/Task tool instead for single-shot research, specialized agent types (Explore, debugger), or context-isolated one-shot results.

Lifecycle: spawn → send → wait → read → (loop or kill). umbel_send does NOT wait — always pair with umbel_wait. Treat wait reason:input as an interrupt, not progress: answer once when expected, but repeated input prompts in one turn usually mean a permission storm or nested workflow — inspect, simplify the task, or kill. Treat dead/connection-closed as failure: capture/logs/status before continuing. Call umbel_help for workflow YAML, provider quirks, or examples.`;

// Per-tool descriptions. Narrow + specific. Lifecycle hints where they
// prevent bugs (send→wait pairing, capture-vs-read).
export const TOOL_DESCRIPTIONS = {
  umbel_spawn:
    'Spawn a worker. `provider` selects claude/codex/gemini/opencode. Returns the session name to pass to other verbs.',
  umbel_send: 'Send a prompt to a session. Returns immediately — pair with umbel_wait.',
  umbel_wait:
    "Block until stop/input/idle/dead/timeout. Call after umbel_send; branch on reason. reason:input means the worker needs a response — send it, then wait again. Pass sinceMtime from umbel_send's result for race-free stop detection across processes.",
  umbel_status:
    "Inspect one session by name, or all if omitted. Shows alive/dead, provider, cwd, last activity, and needsInput + needsInputReason (permission/idle/question) — tells a worker blocked on a prompt from one that's done-and-idle, without scraping the pane.",
  umbel_ls: 'List all sessions. Same as umbel_status with no name.',
  umbel_kill: 'Kill a session and its tmux process. Removes state unless `keepState=true`.',
  umbel_read:
    "Read the last assistant response. Auto-truncates long responses to head+tail (>2000 tokens); pass `full:true`, `head`/`tail` (tokens), or `section` ('## Heading') to control. Call after umbel_wait returns.",
  umbel_actions:
    'Structured digest of what a worker DID this session (tools used, files touched, errors, final message). Use INSTEAD of umbel_read when you want the summary, not the verbatim response — much smaller payload.',
  umbel_diff:
    'Unified text diff between two turns of a session. Default: latest vs previous. Negative indices count from end. Useful in review→fix loops to see only what changed since last turn.',
  umbel_capture:
    'Snapshot N lines from the tmux pane. Human inspection only — use umbel_read to parse agent output.',
  umbel_logs:
    "Read the session's event log. Each end-of-turn appends a timestamp. For lifecycle debugging.",
  umbel_help:
    'Get umbel reference docs. `topic` ∈ {lifecycle, workflow, providers} for a section; omit for the index.',
} as const;

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
  umbel_spawn: (args: {
    name?: string | undefined;
    cwd: string;
    provider?: 'claude' | 'codex' | 'gemini' | 'opencode' | undefined;
    model?: string | undefined;
    allowedTools?: string | undefined;
    permissionMode?: string | undefined;
    unattended?: boolean | undefined;
    env?: Record<string, string | { fromEnv: string }> | undefined;
  }) => Promise<ToolResult>;
  umbel_send: (args: { name: string; prompt: string }) => Promise<ToolResult>;
  umbel_wait: (args: {
    name: string;
    until: 'stop' | 'file' | 'pattern';
    file?: string | undefined;
    pattern?: string | undefined;
    timeout?: string | undefined;
    idleTimeout?: string | undefined;
    sinceMtime?: number | undefined;
  }) => Promise<ToolResult>;
  umbel_status: (args: { name?: string | undefined }) => Promise<ToolResult>;
  umbel_ls: (args: Record<string, never>) => Promise<ToolResult>;
  umbel_kill: (args: { name: string; keepState: boolean }) => Promise<ToolResult>;
  umbel_read: (args: {
    name: string;
    head?: number | undefined;
    tail?: number | undefined;
    section?: string | undefined;
    full?: boolean | undefined;
  }) => Promise<ToolResult>;
  umbel_actions: (args: { name: string }) => Promise<ToolResult>;
  umbel_diff: (args: {
    name: string;
    from?: number | undefined;
    to?: number | undefined;
  }) => Promise<ToolResult>;
  umbel_capture: (args: { name: string; lines: number }) => Promise<ToolResult>;
  umbel_logs: (args: { name: string }) => Promise<ToolResult>;
  umbel_help: (args: { topic?: HelpTopic | undefined }) => Promise<ToolResult>;
}

export function createMcpTools(opts: McpServerOpts): McpToolHandlers {
  const env = opts.env ?? {};
  const deps = opts.deps;
  const d = { ...defaultDeps, ...deps };

  return {
    umbel_spawn: async (args) => {
      const spawnOpts = {
        cwd: args.cwd,
        env,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.allowedTools !== undefined ? { allowedTools: args.allowedTools } : {}),
        ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
        ...(args.unattended !== undefined ? { unattended: args.unattended } : {}),
        ...(args.env !== undefined ? { workerEnv: args.env } : {}),
        ...(deps !== undefined ? { deps } : {}),
      };
      const result = await spawn(spawnOpts);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ name: result.session.name }) }],
      };
    },

    umbel_send: async (args) => {
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

    umbel_wait: async (args) => {
      const idleTimeoutMs =
        args.idleTimeout !== undefined ? parseDuration(args.idleTimeout) : undefined;
      const waitOpts = {
        name: args.name,
        env,
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        ...(args.sinceMtime !== undefined ? { sinceMtime: args.sinceMtime } : {}),
        ...(deps !== undefined ? { deps } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      };
      const result = await waitFor(waitOpts);
      // Surface WHY the wait ended so the orchestrator can branch: 'input' (the
      // worker is blocked on a prompt — `message` carries the question), 'idle',
      // or 'timeout' (paneSnapshot shows the stuck pane).
      const payload: {
        reason: string;
        inputReason?: string;
        message?: string;
        paneSnapshot?: string;
      } = { reason: result.reason };
      if (result.inputReason !== undefined) payload.inputReason = result.inputReason;
      if (result.message !== undefined) payload.message = result.message;
      if (result.paneSnapshot !== undefined) payload.paneSnapshot = result.paneSnapshot;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    },

    umbel_status: async (args) => {
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

    umbel_ls: async (_args) => {
      const entries = await status({ env, ...(deps !== undefined ? { deps } : {}) });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(entries) }],
      };
    },

    umbel_kill: async (args) => {
      const killOpts = {
        name: args.name,
        removeState: !args.keepState,
        env,
        ...(deps !== undefined ? { deps } : {}),
      };
      await kill(killOpts);
      return { content: [{ type: 'text' as const, text: 'killed' }] };
    },

    umbel_read: async (args) => {
      const session = await d.fs.readMeta(args.name, env);
      const provider = getProvider(session.provider);
      let content: string;
      try {
        content = await resolveTranscriptContent({
          name: args.name,
          cwd: session.cwd,
          sinceMs: session.createdAt,
          provider,
          env,
          ...(deps !== undefined ? { deps } : {}),
        });
      } catch (err) {
        if (err instanceof SessionDeadError) {
          return { content: [{ type: 'text' as const, text: '' }] };
        }
        throw err;
      }
      const rawText = provider.parseTranscript(content);
      const truncated = truncateAssistantText(rawText, {
        ...(args.head !== undefined ? { head: args.head } : {}),
        ...(args.tail !== undefined ? { tail: args.tail } : {}),
        ...(args.section !== undefined ? { section: args.section } : {}),
        ...(args.full !== undefined ? { full: args.full } : {}),
      });
      return { content: [{ type: 'text' as const, text: truncated }] };
    },

    umbel_actions: async (args) => {
      const actionsOpts = {
        name: args.name,
        env,
        ...(deps !== undefined ? { deps } : {}),
      };
      const text = await actions(actionsOpts);
      return { content: [{ type: 'text' as const, text }] };
    },

    umbel_diff: async (args) => {
      const diffOpts = {
        name: args.name,
        env,
        ...(deps !== undefined ? { deps } : {}),
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.to !== undefined ? { to: args.to } : {}),
      };
      const text = await diff(diffOpts);
      return { content: [{ type: 'text' as const, text }] };
    },

    umbel_capture: async (args) => {
      const text = await d.tmux.capturePane(args.name, args.lines);
      return { content: [{ type: 'text' as const, text }] };
    },

    umbel_logs: async (args) => {
      const logPath = `${d.fs.eventsDir(args.name, env)}/log`;
      let content = '';
      try {
        content = await Bun.file(logPath).text();
      } catch {
        content = '';
      }
      return { content: [{ type: 'text' as const, text: content }] };
    },

    umbel_help: async (args) => {
      return {
        content: [{ type: 'text' as const, text: helpForTopic(args.topic) }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// runMcpServer — entry point; delegates to createMcpTools + stdio transport
// ---------------------------------------------------------------------------

export async function runMcpServer(opts: McpServerOpts): Promise<void> {
  const tools = createMcpTools(opts);

  const server = new McpServer(
    { name: 'umbel', version: '0.0.1' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.tool(
    'umbel_spawn',
    TOOL_DESCRIPTIONS.umbel_spawn,
    VerbSchemas.spawn.shape,
    tools.umbel_spawn,
  );
  server.tool('umbel_send', TOOL_DESCRIPTIONS.umbel_send, VerbSchemas.send.shape, tools.umbel_send);
  server.tool('umbel_wait', TOOL_DESCRIPTIONS.umbel_wait, VerbSchemas.wait.shape, tools.umbel_wait);
  server.tool(
    'umbel_status',
    TOOL_DESCRIPTIONS.umbel_status,
    VerbSchemas.status.shape,
    tools.umbel_status,
  );
  server.tool('umbel_ls', TOOL_DESCRIPTIONS.umbel_ls, VerbSchemas.ls.shape, tools.umbel_ls);
  server.tool('umbel_kill', TOOL_DESCRIPTIONS.umbel_kill, VerbSchemas.kill.shape, tools.umbel_kill);
  server.tool('umbel_read', TOOL_DESCRIPTIONS.umbel_read, VerbSchemas.read.shape, tools.umbel_read);
  server.tool(
    'umbel_actions',
    TOOL_DESCRIPTIONS.umbel_actions,
    { name: z.string() },
    tools.umbel_actions,
  );
  server.tool(
    'umbel_diff',
    TOOL_DESCRIPTIONS.umbel_diff,
    { name: z.string(), from: z.number().int().optional(), to: z.number().int().optional() },
    tools.umbel_diff,
  );
  server.tool(
    'umbel_capture',
    TOOL_DESCRIPTIONS.umbel_capture,
    VerbSchemas.capture.shape,
    tools.umbel_capture,
  );
  server.tool('umbel_logs', TOOL_DESCRIPTIONS.umbel_logs, { name: z.string() }, tools.umbel_logs);
  server.tool(
    'umbel_help',
    TOOL_DESCRIPTIONS.umbel_help,
    { topic: z.enum(HELP_TOPICS).optional() },
    tools.umbel_help,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Block until the session ends, then return so main.ts can process.exit().
  //
  // CRITICAL: the MCP SDK's StdioServerTransport registers only 'data'/'error'
  // listeners on stdin — it does NOT watch for 'end'/'close', and its onclose
  // only fires on an explicit transport.close(). So when the parent (the MCP
  // client) dies, stdin hits EOF but nothing here would notice: the process
  // would stay alive on this Promise AND leave stdin flowing on an EOF'd pipe,
  // busy-looping a CPU core. We must detect EOF ourselves.
  //
  // Resolve on ANY of: stdin end/close (parent death), SIGINT/SIGTERM, or an
  // injected opts.signal (used by in-proc tests).
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        done();
        return;
      }
      opts.signal.addEventListener('abort', done, { once: true });
    }

    process.stdin.once('end', done);
    process.stdin.once('close', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    // stdin must be flowing/resumed for 'end' to fire on EOF. The transport's
    // 'data' listener already resumed it, but resume() is idempotent + safe.
    process.stdin.resume();
  });

  // Clean shutdown: removes the transport's stdin listeners and pauses stdin
  // so the fd stops being polled. Best-effort — we're exiting regardless.
  await transport.close().catch(() => undefined);
}
