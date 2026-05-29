import { join } from 'node:path';
import type { ActionManifest, AgentProvider, ProviderLaunchSpec, Turn } from './types.ts';

// ---------------------------------------------------------------------------
// Internal JSONL parsing — Codex rollout format
// ---------------------------------------------------------------------------
// NOTE: Codex docs warn that "the transcript format is not a stable interface
// for hooks and may change over time." This parser reads only the
// event_msg/agent_message envelope, which is the most stable public shape.
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Codex JSONL uses: { "type": "event_msg", "payload": { "type": "agent_message", "message": "..." } }
// Walk backward to find the last agent_message (arrives once per turn; no
// partial streaming — Codex fully writes before firing Stop).
function extractLastAgentMessage(content: string): string {
  const lines = content
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .reverse();

  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as JsonObj;

    if (obj.type !== 'event_msg') continue;

    const payload = obj.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const p = payload as JsonObj;

    if (p.type === 'agent_message' && typeof p.message === 'string') {
      return p.message;
    }
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
// each event_msg/task_complete event. The turn's text is the most recent
// event_msg/agent_message seen before that task_complete. Pure — never throws;
// returns [] for empty/malformed input.
export function extractCodexTurnsFromContent(content: string): Turn[] {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  const turns: Turn[] = [];
  let currentMessage = '';
  let idx = 0;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as JsonObj;
    if (obj.type !== 'event_msg') continue;
    const payload = obj.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const p = payload as JsonObj;

    if (p.type === 'agent_message' && typeof p.message === 'string') {
      currentMessage = p.message;
    } else if (p.type === 'task_complete') {
      turns.push({ index: idx, text: currentMessage });
      idx++;
      currentMessage = '';
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// CodexProvider
// ---------------------------------------------------------------------------

const codexProvider: AgentProvider = {
  name: 'codex',

  stopEventName: 'Stop',

  // Codex's TUI shows up to THREE interactive gates on first launch in a
  // fresh cwd (verified against the real 0.133/0.135 binary). They appear in
  // this order, but each is matched independently against the live pane, so
  // the loop dismisses whichever is actually showing:
  //   1. "Update available!" — options Update now / Skip / Skip until next.
  //      We MUST avoid the default "Update now" (it runs `npm install -g`);
  //      Down then Enter selects "Skip". Only appears when an update is
  //      pending, hence variable ordering.
  //   2. "Do you trust the contents of this directory?" — default "Yes,
  //      continue"; a single Enter dismisses it. Also gates hook loading —
  //      until the dir is trusted, hooks won't load at all.
  //   3. "Hooks need review" — we need option 2 "Trust all and continue",
  //      reached with Down then Enter, so our Stop hook runs.
  // codex persists the trust + hook decisions to ~/.codex/config.toml, so
  // later launches in the same dir skip 2 and 3 — the loop then no-ops and
  // readyMatch fires.
  startupDialogs: [
    { match: /update available/i, keys: ['Down', 'Enter'] },
    { match: /trust the contents of this directory/i, keys: ['Enter'] },
    { match: /hooks need review/i, keys: ['Down', 'Enter'] },
  ],
  readyMatch: /OpenAI Codex|Implement \{|gpt-/i,

  // Codex's TUI ignores a submitting Enter that lands immediately after the
  // pasted prompt — the text stays in the input box, unsent, and no turn runs.
  // A pause before Enter lets it ingest the paste. 750ms verified sufficient
  // against the real binary (an immediate Enter consistently failed).
  submitDelayMs: 750,

  buildLaunch(opts): ProviderLaunchSpec {
    // Codex has no --config-dir or --hooks flag. Hook discovery is via the
    // filesystem: $CODEX_HOME/hooks.json or <cwd>/.codex/hooks.json. We write
    // to the project-level path to avoid mutating user globals. The operations
    // layer records the absolute path in meta.providerFiles and removes it on kill.
    //
    // Schema: codex-rs/config/src/hook_config.rs — HooksFile, MatcherGroup,
    // HookHandlerConfig. timeout is in seconds (not ms). matcher is optional.
    const hooksJson = JSON.stringify({
      hooks: {
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
      },
    });

    const args: string[] = [];
    if (opts.model !== undefined) {
      args.push('--model', opts.model);
    }

    return {
      bin: 'codex',
      args,
      env: {},
      files: [
        {
          path: join(opts.cwd, '.codex', 'hooks.json'),
          content: hooksJson,
          mode: 0o644,
        },
      ],
    };
  },

  parseTranscript(content: string): string {
    return extractLastAgentMessage(content);
  },

  extractActions(content: string): ActionManifest {
    return extractCodexActionsFromContent(content);
  },

  extractTurns(content: string): Turn[] {
    return extractCodexTurnsFromContent(content);
  },
} as const;

export const CodexProvider: AgentProvider = codexProvider;
