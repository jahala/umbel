import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActionManifest, AgentProvider, ProviderLaunchSpec, Turn, Usage } from './types.ts';
import {
  addCacheReadTokens,
  addCacheWriteTokens,
  addInputTokens,
  addOutputTokens,
  emptyUsageTotals,
  numberField,
  usageOf,
} from './usage.ts';

// ---------------------------------------------------------------------------
// Internal JSONL parsing — Codex rollout format
// ---------------------------------------------------------------------------
// NOTE: Codex docs warn that "the transcript format is not a stable interface
// for hooks and may change over time." It did: codex-cli 0.154.0 writes no
// event_msg/agent_message at all (jahala/umbel#97). The turn's text now lives
// in event_msg/task_complete.last_agent_message and in event_msg/item_completed
// carrying an AgentMessage item. This parser reads those first and keeps the
// agent_message shape for older rollouts. It reads event_msg records only.
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// The text an event_msg payload carries for the assistant's turn, or null when
// it carries none. Three shapes, newest first:
//   0.154.0  { type: "task_complete", last_agent_message: "..." }
//   0.154.0  { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text }] } }
//   older    { type: "agent_message", message: "..." }
// A task_complete whose last_agent_message is null says nothing (the item or
// an older shape may still carry the text), so it is null here, not ''.
function agentTextOf(p: JsonObj): string | null {
  if (p.type === 'task_complete' && typeof p.last_agent_message === 'string') {
    return p.last_agent_message;
  }
  if (p.type === 'item_completed' && p.item !== null && typeof p.item === 'object') {
    const item = p.item as JsonObj;
    if (item.type === 'AgentMessage' && Array.isArray(item.content)) {
      const parts = item.content
        .filter((c): c is JsonObj => c !== null && typeof c === 'object')
        .map((c) => (typeof c.text === 'string' ? c.text : ''));
      return parts.join('');
    }
  }
  if (p.type === 'agent_message' && typeof p.message === 'string') {
    return p.message;
  }
  return null;
}

function eventPayload(line: string): JsonObj | null {
  const parsed = parseLine(line);
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as JsonObj;
  if (obj.type !== 'event_msg') return null;
  const payload = obj.payload;
  if (payload === null || typeof payload !== 'object') return null;
  return payload as JsonObj;
}

// A rollout brackets each turn with task_started and task_complete, or
// turn_aborted when it is cut short. The turn is open only while the newest of
// those is task_started. A rollout without the markers cannot prove a turn
// open, so it never holds a read.
function turnEndedIn(content: string): boolean {
  let newest: unknown;
  for (const line of content.split('\n')) {
    const type = eventPayload(line)?.type;
    if (type === 'task_started' || type === 'task_complete' || type === 'turn_aborted') {
      newest = type;
    }
  }
  return newest !== 'task_started';
}

// Walk backward to the newest record that carries the assistant's text (each
// arrives once per turn; no partial streaming — Codex fully writes before
// firing Stop).
function extractLastAgentMessage(content: string): string {
  const lines = content
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .reverse();

  for (const line of lines) {
    const p = eventPayload(line);
    if (p === null) continue;
    const text = agentTextOf(p);
    if (text !== null) return text;
  }

  return '';
}

// ---------------------------------------------------------------------------
// Action extraction (pure, defensive)
// ---------------------------------------------------------------------------
//
// CONFIDENCE LEVEL: medium. We know event_msg/agent_message and
// event_msg/task_complete shapes (used by parseTranscript + verified by
// fake-codex.sh). tool_call / tool_result shapes are *inferred* by analogy to
// agent_message — not verified against a real Codex transcript. Until that
// verification happens, tool extraction may be partial. Final-message and
// turn-count remain reliable.
//
// TODO(b3-codex): verify tool_call/tool_result event shape against a real
// Codex rollout file and refine field extraction.

function pushUnique(arr: string[], val: string): void {
  if (!arr.includes(val)) arr.push(val);
}

export function extractCodexActionsFromContent(content: string): ActionManifest {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  const toolsUsed: Record<string, number> = {};
  const filesRead: string[] = [];
  const filesEdited: string[] = [];
  const filesWritten: string[] = [];
  const bashCommands: string[] = [];
  const errors: string[] = [];
  let turnCount = 0;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as JsonObj;

    if (obj.type !== 'event_msg') continue;
    const payload = obj.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const p = payload as JsonObj;

    if (p.type === 'task_complete') {
      turnCount++;
      continue;
    }

    // Defensive tool_call extraction. Codex docs don't pin a shape yet, so
    // accept either { tool_name } or { name } and { arguments } or { input }.
    if (p.type === 'tool_call') {
      const toolName =
        typeof p.tool_name === 'string'
          ? p.tool_name
          : typeof p.name === 'string'
            ? p.name
            : undefined;
      if (toolName !== undefined) {
        toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;

        const argsField =
          p.arguments !== undefined && typeof p.arguments === 'object'
            ? (p.arguments as JsonObj)
            : p.input !== undefined && typeof p.input === 'object'
              ? (p.input as JsonObj)
              : null;

        if (argsField !== null) {
          const filePath =
            typeof argsField.file_path === 'string' ? argsField.file_path : undefined;
          const command = typeof argsField.command === 'string' ? argsField.command : undefined;
          if (toolName === 'Read' && filePath !== undefined) pushUnique(filesRead, filePath);
          else if ((toolName === 'Edit' || toolName === 'MultiEdit') && filePath !== undefined)
            pushUnique(filesEdited, filePath);
          else if (toolName === 'Write' && filePath !== undefined)
            pushUnique(filesWritten, filePath);
          else if (toolName === 'Bash' && command !== undefined) bashCommands.push(command);
        }
      }
    }

    // Defensive tool_result error extraction.
    if (p.type === 'tool_result' && p.is_error === true) {
      const msg =
        typeof p.output === 'string'
          ? p.output
          : typeof p.content === 'string'
            ? p.content
            : typeof p.message === 'string'
              ? p.message
              : '';
      if (msg.length > 0) errors.push(msg);
    }
  }

  return {
    toolsUsed,
    filesRead,
    filesEdited,
    filesWritten,
    bashCommands,
    errors,
    finalMessage: extractLastAgentMessage(content),
    turnCount,
  };
}

// Pure: split a Codex rollout transcript into completed turns. A turn ends at
// each event_msg/task_complete event. The turn's text is task_complete's own
// last_agent_message when it carries one, else the most recent agent text seen
// before it (an AgentMessage item, or agent_message in older rollouts). Pure —
// never throws; returns [] for empty/malformed input.
export function extractCodexTurnsFromContent(content: string): Turn[] {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  const turns: Turn[] = [];
  let currentMessage = '';
  let idx = 0;
  for (const line of lines) {
    const p = eventPayload(line);
    if (p === null) continue;

    if (p.type === 'task_complete') {
      turns.push({ index: idx, text: agentTextOf(p) ?? currentMessage });
      idx++;
      currentMessage = '';
      continue;
    }
    const text = agentTextOf(p);
    if (text !== null) currentMessage = text;
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Usage extraction (pure)
// ---------------------------------------------------------------------------

function asObject(value: unknown): JsonObj | null {
  return value !== null && typeof value === 'object' ? (value as JsonObj) : null;
}

// Codex counts cached input inside input_tokens, while claude and opencode do
// not. Subtracting the cache fields here gives `inputTokens` one meaning across
// providers. A negative result is clamped: the counts come from different API
// calls and a cache can report more than the input it served.
function addCodexUsage(totals: ReturnType<typeof emptyUsageTotals>, usage: JsonObj): void {
  const input = numberField(usage, 'input_tokens');
  const cached = numberField(usage, 'cached_input_tokens') ?? 0;
  const cacheWrite = numberField(usage, 'cache_write_input_tokens') ?? 0;
  if (input !== undefined) addInputTokens(totals, Math.max(0, input - cached - cacheWrite));
  addCacheReadTokens(totals, numberField(usage, 'cached_input_tokens'));
  addCacheWriteTokens(totals, numberField(usage, 'cache_write_input_tokens'));
  addOutputTokens(totals, numberField(usage, 'output_tokens'));
}

// token_usage_record.turn_token_usage is the turn's share: it resets at each
// task_started while thread_token_usage runs on, so the newest record inside the
// completed turn is the whole turn. Older rollouts carry no such record; there
// token_count.info.last_token_usage is one API call, and summing the calls since
// task_started gives the same turn total. An open newest turn is ignored.
export function extractCodexUsageFromContent(content: string): Usage | undefined {
  let model: string | undefined;
  let inTurn = false;
  let turnTotals = emptyUsageTotals();
  let fromRecord = false;
  let completed: { totals: ReturnType<typeof emptyUsageTotals>; model?: string } | undefined;

  for (const line of content.split('\n')) {
    const parsed = parseLine(line);
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as JsonObj;

    if (obj.type === 'turn_context') {
      const payload = asObject(obj.payload);
      if (payload !== null && typeof payload.model === 'string') model = payload.model;
      continue;
    }

    if (obj.type === 'token_usage_record') {
      const payload = asObject(obj.payload);
      const usage = payload !== null ? asObject(payload.turn_token_usage) : null;
      if (usage !== null) {
        turnTotals = emptyUsageTotals();
        addCodexUsage(turnTotals, usage);
        fromRecord = true;
      }
      continue;
    }

    if (obj.type !== 'event_msg') continue;
    const payload = asObject(obj.payload);
    if (payload === null) continue;

    if (payload.type === 'task_started') {
      inTurn = true;
      turnTotals = emptyUsageTotals();
      fromRecord = false;
      continue;
    }

    if (payload.type === 'token_count') {
      if (!inTurn || fromRecord) continue;
      const info = asObject(payload.info);
      const last = info !== null ? asObject(info.last_token_usage) : null;
      if (last !== null) addCodexUsage(turnTotals, last);
      continue;
    }

    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      if (inTurn && usageOf(turnTotals) !== undefined) {
        completed = { totals: turnTotals, ...(model !== undefined ? { model } : {}) };
      }
      inTurn = false;
      turnTotals = emptyUsageTotals();
      fromRecord = false;
    }
  }

  return completed === undefined ? undefined : usageOf(completed.totals, completed.model);
}

// ---------------------------------------------------------------------------
// CodexProvider
// ---------------------------------------------------------------------------

const codexProvider: AgentProvider = {
  name: 'codex',
  supportsUnattended: true,
  inheritEnv: ['OPENAI_*'],

  stopEventName: 'Stop',

  // Seen on codex workers that then sat at their prompt with a live session
  // (jahala/umbel#67): "unexpected status 404 Not Found: ..." on 2026-09-09 and
  // "... does not exist or you do not have access to it" on 2026-09-10.
  errorMatch: [/unexpected status \d{3}/i, /does not exist or you do not have access/i],

  // Codex's TUI shows up to three gates at startup: the update dialog (only
  // when an update is pending), the directory trust dialog (only if a codex
  // ignores the trust buildLaunch passes), and "Hooks need review" (whenever
  // umbel's hooks.json is new or changed for this CODEX_HOME). Each is matched
  // on its HIGHLIGHTED option (the line starting with ›), so the keys depend on
  // where the cursor actually sits, as claude's dialogs do. Relative keys sent
  // twice moved the cursor past the answer: codex keeps the hooks dialog on
  // screen while it writes the trust ("Trusting hooks..."), the loop read that
  // as swallowed keys and pressed Down+Enter again, which confirmed "Continue
  // without trusting", so no umbel hook loaded and workers never stopped
  // (verified on 0.154.0, 2026-10-22). Option text taken from that binary.
  // "Update now" runs `npm install -g` and must never be confirmed.
  startupDialogs: [
    { match: /^\s*›\s*1\. Update now/m, keys: ['Down', 'Enter'] },
    { match: /^\s*›\s*2\. Skip\s*$/m, keys: ['Enter'] },
    { match: /^\s*›\s*3\. Skip until next version/m, keys: ['Enter'] },
    { match: /^\s*›\s*1\. Yes, continue/m, keys: ['Enter'] },
    { match: /^\s*›\s*2\. No, quit/m, keys: ['Up', 'Enter'] },
    // Numbered (`› 1. Review hooks`) when every hook is new, unnumbered when
    // some changed; both recorded on 0.154.0.
    { match: /^\s*›\s*(?:\d\.\s*)?Review hooks\s*$/m, keys: ['Down', 'Enter'] },
    { match: /^\s*›\s*(?:\d\.\s*)?Trust all and continue\s*$/m, keys: ['Enter'] },
    { match: /^\s*›\s*(?:\d\.\s*)?Continue without trusting/m, keys: ['Up', 'Enter'] },
  ],
  // The idle prompt line (0.154.0: "› Ask Codex to do anything"; older builds:
  // "Implement {feature}"). The banner paints before the model has loaded and
  // before a late trust dialog, so it is not a ready signal
  // (test/fixtures/codex-0.154-startup.txt). The screen keeps re-rendering for
  // seconds after, hence the settle window.
  // Ready is the idle prompt line below a banner that names its model: the
  // prompt line paints while the model is still loading, and a dialog can open
  // after it (2026-10-22, "Hooks need review" ~2 s after spawn returned on a
  // loading banner, and the first prompt went into it).
  readyMatch:
    /model:\s+(?!loading)\S[^\n]*\n(?:(?!model:)[\s\S])*?› Ask Codex to do anything|Implement \{/,
  readySettleMs: 1500,
  // 0.154.0 with no credentials opens on its sign-in menu.
  signInMatch: /^\s*or connect an API key for usage-based billing\s*$/m,

  // Codex's TUI ignores a submitting Enter that lands immediately after the
  // pasted prompt — the text stays in the input box, unsent, and no turn runs.
  // A pause before Enter lets it ingest the paste. 750ms verified sufficient
  // against the real binary (an immediate Enter consistently failed).
  submitDelayMs: 750,
  // Even with the delay, 0.154.0 can keep a paste as this placeholder and never
  // run it (jahala/umbel#77); send presses Enter again while it is on the pane.
  pendingInputMatch: /\[Pasted Content \d+ chars\]/,

  buildLaunch(opts): ProviderLaunchSpec {
    // Hook delivery via a global $CODEX_HOME/hooks.json — NOT <cwd>/.codex/hooks.json,
    // which codex silently ignores inside linked git worktrees (verified against
    // 0.133.0; see docs/codex-worktree-hooks.md). umbel points the worker at an
    // isolated, shared CODEX_HOME under the state dir: auth.json is symlinked from
    // the user's real CODEX_HOME (no secret copy; token refresh shared) and
    // config.toml is copied once (carries model/endpoint/MCP, kept isolated so
    // codex's trust writes don't touch the user's global config). These three files
    // are `shared` — set up idempotently, never recorded per-session or cleaned on
    // kill. umbel's startup dialogs trust the hooks on first use.
    //
    // Schema: codex-rs/config/src/hook_config.rs — HooksFile, MatcherGroup,
    // HookHandlerConfig. timeout is in seconds (not ms). matcher is optional.
    const hooks: Record<string, unknown> = {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: opts.hookScriptPath,
              timeout: 30,
            },
          ],
        },
      ],
    };
    // SessionStart binds the worker's own codex session id (umbel#118). A codex
    // the worker starts inherits CODEX_HOME, so its Stop would otherwise settle
    // the worker's wait. The TUI fires SessionStart as the first turn starts,
    // before any tool call; verified on 0.154.0 that its payload carries the
    // same session_id as Stop.
    if (opts.bindScriptPath !== undefined) {
      hooks.SessionStart = [
        {
          hooks: [
            {
              type: 'command',
              command: opts.bindScriptPath,
              timeout: 30,
            },
          ],
        },
      ];
    }
    // PermissionRequest fires when Codex needs approval for a tool call — the
    // worker is BLOCKED. Lets a waiter return 'input' instead of hanging.
    // Verified against codex 0.133.0 (HookEventNameWire enum); timeout in seconds.
    if (opts.notifyScriptPath !== undefined) {
      hooks.PermissionRequest = [
        {
          hooks: [
            {
              type: 'command',
              command: opts.notifyScriptPath,
              timeout: 30,
            },
          ],
        },
      ];
    }
    const hooksJson = JSON.stringify({ hooks });

    const args: string[] = [];
    if (opts.unattended === true || opts.permissionMode === 'bypassPermissions') {
      // Skip approval prompts + the sandbox so a conductor-driven worker (e.g.
      // the cross-provider audit) can run commands with no human present.
      // Safety is external — the worker runs in a disposable worktree, gated by
      // the audit.
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (opts.model !== undefined) {
      args.push('--model', opts.model);
    }
    // codex asks whether to trust any directory it has not seen, and every
    // pleach worktree is one (umbel#112). Trust is keyed on the exact resolved
    // path; a trusted parent does not cover it. As a `-c` override nothing is
    // written to config.toml. The inline table is required: the dotted form
    // `projects."<path>".trust_level` was ignored by 0.154.0.
    if (opts.realCwd !== undefined) {
      args.push('-c', `projects={${JSON.stringify(opts.realCwd)}={trust_level="trusted"}}`);
    }

    const codexHome = join(opts.stateDir ?? join(homedir(), '.umbel'), 'codex-home');
    const userCodexHome = opts.userCodexHome ?? join(homedir(), '.codex');
    return {
      bin: 'codex',
      args,
      env: { CODEX_HOME: codexHome },
      files: [
        { path: join(codexHome, 'hooks.json'), content: hooksJson, mode: 0o644, shared: true },
        {
          path: join(codexHome, 'auth.json'),
          symlinkTo: join(userCodexHome, 'auth.json'),
          shared: true,
        },
        {
          path: join(codexHome, 'config.toml'),
          copyFrom: join(userCodexHome, 'config.toml'),
          ifAbsent: true,
          shared: true,
        },
      ],
    };
  },

  parseTranscript(content: string): string {
    return extractLastAgentMessage(content);
  },

  turnEnded(content: string): boolean {
    return turnEndedIn(content);
  },

  extractUsage(content: string): Usage | undefined {
    return extractCodexUsageFromContent(content);
  },

  extractActions(content: string): ActionManifest {
    return extractCodexActionsFromContent(content);
  },

  extractTurns(content: string): Turn[] {
    return extractCodexTurnsFromContent(content);
  },
} as const;

export const CodexProvider: AgentProvider = codexProvider;
