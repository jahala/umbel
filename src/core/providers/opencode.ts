import type { ActionManifest, AgentProvider, ProviderLaunchSpec, Turn } from './types.ts';

// ---------------------------------------------------------------------------
// PLUGIN_SOURCE — bundled opencode JS plugin written verbatim to disk.
//
// Runs inside opencode's JS runtime. Cannot import rctrl. All logic is inline.
// No-ops unless RCTRL_STATE and RCTRL_SESSION_ID are set (inert in normal use).
// On session.status {type:"idle"}: writes events/session-id and touches events/stop.
// On permission.updated: touches events/notification (worker blocked on approval).
// ---------------------------------------------------------------------------

export const PLUGIN_SOURCE = `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function fireStop(sessionID) {
  const state = process.env.RCTRL_STATE;
  const rctrlSession = process.env.RCTRL_SESSION_ID;
  if (!state || !rctrlSession) return;
  const eventsDir = join(state, "sessions", rctrlSession, "events");
  await mkdir(eventsDir, { recursive: true });
  await writeFile(join(eventsDir, "session-id"), String(sessionID), "utf8");
  await writeFile(join(eventsDir, "stop"), "", "utf8");
  const ts = String(Date.now() * 1_000_000);
  const logPath = join(eventsDir, "log");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(logPath, ts + "\\n", "utf8");
}

async function fireNotification(message) {
  const state = process.env.RCTRL_STATE;
  const rctrlSession = process.env.RCTRL_SESSION_ID;
  if (!state || !rctrlSession) return;
  const eventsDir = join(state, "sessions", rctrlSession, "events");
  await mkdir(eventsDir, { recursive: true });
  await writeFile(join(eventsDir, "notification"), String(message ?? ""), "utf8");
  const ts = String(Date.now() * 1_000_000);
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(eventsDir, "log"), ts + "\\n", "utf8");
}

export const Plugin = async () => ({
  event: async ({ event }) => {
    if (
      event?.type === "session.status" &&
      event?.properties?.status?.type === "idle" &&
      !!process.env.RCTRL_STATE &&
      !!process.env.RCTRL_SESSION_ID
    ) {
      await fireStop(event?.properties?.sessionID ?? "");
    }
    if (
      event?.type === "permission.updated" &&
      !!process.env.RCTRL_STATE &&
      !!process.env.RCTRL_SESSION_ID
    ) {
      await fireNotification(event?.properties?.title ?? event?.properties?.type ?? "permission");
    }
  },
});

export default Plugin;
`;

// ---------------------------------------------------------------------------
// parseTranscript — parse opencode export JSON, return last assistant text.
// Pure / total: never throws; returns '' on empty/whitespace/malformed input.
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

function parseTranscript(content: string): string {
  if (content.trim().length === 0) return '';
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return '';
  }
  if (obj === null || typeof obj !== 'object') return '';
  const root = obj as JsonObj;
  const messages = root.messages;
  if (!Array.isArray(messages) || messages.length === 0) return '';

  // Find the last message whose info.role === 'assistant'.
  let lastAssistantMsg: JsonObj | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === null || typeof m !== 'object') continue;
    const msg = m as JsonObj;
    const info = msg.info;
    if (info !== null && typeof info === 'object') {
      const inf = info as JsonObj;
      if (inf.role === 'assistant') {
        lastAssistantMsg = msg;
        break;
      }
    }
  }

  if (lastAssistantMsg === null) return '';

  const parts = lastAssistantMsg.parts;
  if (!Array.isArray(parts)) return '';

  const textParts: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const p = part as JsonObj;
    if (p.type === 'text' && typeof p.text === 'string') {
      textParts.push(p.text);
    }
  }

  return textParts.join('');
}

// ---------------------------------------------------------------------------
// extractAssistantMessages — internal helper: return messages whose
// info.role === 'assistant', in order. Never throws; returns [] on malformed.
// ---------------------------------------------------------------------------

function extractAssistantMessages(root: JsonObj): JsonObj[] {
  const messages = root.messages;
  if (!Array.isArray(messages)) return [];
  const result: JsonObj[] = [];
  for (const m of messages) {
    if (m === null || typeof m !== 'object') continue;
    const msg = m as JsonObj;
    const info = msg.info;
    if (info === null || typeof info !== 'object') continue;
    const inf = info as JsonObj;
    if (inf.role === 'assistant') result.push(msg);
  }
  return result;
}

// ---------------------------------------------------------------------------
// extractTextFromParts — internal helper: concatenate type:'text' parts.
// ---------------------------------------------------------------------------

function extractTextFromParts(msg: JsonObj): string {
  const parts = msg.parts;
  if (!Array.isArray(parts)) return '';
  const textParts: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const p = part as JsonObj;
    if (p.type === 'text' && typeof p.text === 'string') {
      textParts.push(p.text);
    }
  }
  return textParts.join('');
}

// ---------------------------------------------------------------------------
// parseRoot — shared JSON parse + root validation. Returns null on malformed.
// ---------------------------------------------------------------------------

function parseRoot(content: string): JsonObj | null {
  if (content.trim().length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  return obj as JsonObj;
}

// ---------------------------------------------------------------------------
// extractOpencodeTurnsFromContent — pure, total: one Turn per assistant
// message, in order. Index is 0-based. Text = concatenation of type:'text'
// parts. Never throws; returns [] for empty/malformed input.
// ---------------------------------------------------------------------------

export function extractOpencodeTurnsFromContent(content: string): Turn[] {
  const root = parseRoot(content);
  if (root === null) return [];
  const assistants = extractAssistantMessages(root);
  return assistants.map((msg, idx) => ({ index: idx, text: extractTextFromParts(msg) }));
}

// ---------------------------------------------------------------------------
// extractOpencodeActionsFromContent — pure, defensive:
//
// CONFIDENCE LEVEL: medium. RELIABLE fields: finalMessage (reuses
// parseTranscript logic), turnCount (= number of assistant messages).
// DEFENSIVE/INFERRED fields: tool extraction scans assistant parts for
// tool-call-like entries. Tool-call part shape is NOT documented in the
// opencode export spec — it is inferred by analogy with Claude's tool_use
// format and Codex/Gemini extractors:
//
//   { type: 'tool-call', toolName: string, args?: {...} | input?: {...} }
//
// Tool-result errors inferred as:
//   { type: 'tool-result', isError: true, content?: string | output?: string }
//
// TODO(opencode): verify tool-call part shape against a real tool-using
// transcript and refine field extraction.
// ---------------------------------------------------------------------------

function pushUnique(arr: string[], val: string): void {
  if (!arr.includes(val)) arr.push(val);
}

export function extractOpencodeActionsFromContent(content: string): ActionManifest {
  const root = parseRoot(content);
  if (root === null) {
    return {
      toolsUsed: {},
      filesRead: [],
      filesEdited: [],
      filesWritten: [],
      bashCommands: [],
      errors: [],
      finalMessage: '',
      turnCount: 0,
    };
  }

  const toolsUsed: Record<string, number> = {};
  const filesRead: string[] = [];
  const filesEdited: string[] = [];
  const filesWritten: string[] = [];
  const bashCommands: string[] = [];
  const errors: string[] = [];

  const assistants = extractAssistantMessages(root);

  for (const msg of assistants) {
    const parts = msg.parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue;
      const p = part as JsonObj;

      // Defensive tool-call extraction. Accept { toolName } (camelCase) with
      // { args } or { input } containing optional file_path / command fields.
      if (typeof p.type === 'string' && p.type.includes('tool-call')) {
        const toolName = typeof p.toolName === 'string' ? p.toolName : undefined;
        if (toolName !== undefined) {
          toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;

          const argsField =
            p.args !== undefined && typeof p.args === 'object'
              ? (p.args as JsonObj)
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

      // Defensive tool-result error extraction.
      if (typeof p.type === 'string' && p.type.includes('tool-result') && p.isError === true) {
        const msg =
          typeof p.content === 'string'
            ? p.content
            : typeof p.output === 'string'
              ? p.output
              : typeof p.message === 'string'
                ? p.message
                : '';
        if (msg.length > 0) errors.push(msg);
      }
    }
  }

  const lastAssistant: JsonObj | null =
    assistants.length > 0 ? (assistants[assistants.length - 1] ?? null) : null;

  return {
    toolsUsed,
    filesRead,
    filesEdited,
    filesWritten,
    bashCommands,
    errors,
    finalMessage: lastAssistant !== null ? extractTextFromParts(lastAssistant) : '',
    turnCount: assistants.length,
  };
}

// ---------------------------------------------------------------------------
// opencodePluginShouldFire — pure gating predicate mirrored in the plugin.
// True iff event is session.status idle AND both rctrl env vars are set.
// Never throws.
// ---------------------------------------------------------------------------

export function opencodePluginShouldFire(
  event: unknown,
  env: Record<string, string | undefined>,
): boolean {
  if (event === null || typeof event !== 'object') return false;
  const e = event as JsonObj;
  if (e.type !== 'session.status') return false;
  const props = e.properties;
  if (props === null || typeof props !== 'object') return false;
  const p = props as JsonObj;
  const status = p.status;
  if (status === null || typeof status !== 'object') return false;
  const s = status as JsonObj;
  if (s.type !== 'idle') return false;
  return !!env?.RCTRL_STATE && !!env?.RCTRL_SESSION_ID;
}

// A permission event means opencode is BLOCKED asking the user to approve a tool
// call. The v1 plugin `event` stream delivers these as `permission.updated`
// (verified against @opencode-ai/sdk 1.15.12 — `permission.asked` is v2-only).
// Pure + total: never throws; env-gated like opencodePluginShouldFire.
export function opencodePluginShouldFireNotification(
  event: unknown,
  env: Record<string, string | undefined>,
): boolean {
  if (event === null || typeof event !== 'object') return false;
  const e = event as JsonObj;
  if (e.type !== 'permission.updated') return false;
  return !!env?.RCTRL_STATE && !!env?.RCTRL_SESSION_ID;
}

// ---------------------------------------------------------------------------
// mergeOpencodePluginConfig — pure: idempotently add pluginAbsPath to the
// opencode config's "plugin" array. Preserves all other keys.
// Returns valid JSON string. Never throws.
// ---------------------------------------------------------------------------

export function mergeOpencodePluginConfig(existing: string | null, pluginAbsPath: string): string {
  let config: JsonObj = {};
  if (existing !== null && existing.trim().length > 0) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as JsonObj;
      }
    } catch {
      // malformed → treat as empty
    }
  }

  const existingPlugins = Array.isArray(config.plugin) ? (config.plugin as unknown[]) : [];
  const alreadyPresent = existingPlugins.some((p) => p === pluginAbsPath);
  if (!alreadyPresent) {
    config = { ...config, plugin: [...existingPlugins, pluginAbsPath] };
  }

  return JSON.stringify(config, null, 2);
}

// ---------------------------------------------------------------------------
// OpenCodeProvider
// ---------------------------------------------------------------------------

const opencodeProvider: AgentProvider = {
  name: 'opencode',

  stopEventName: 'session.status',

  // opencode's TUI shows no startup dialogs in a fresh cwd.
  startupDialogs: [],

  readyMatch: /Ask anything\.\.\.|Build · /,

  buildLaunch(opts): ProviderLaunchSpec {
    const args: string[] = [];
    if (opts.model !== undefined) {
      args.push('-m', opts.model);
    }
    return {
      bin: 'opencode',
      args,
      env: {},
      // opencode uses a global plugin (installed by installGlobalPlugin), not
      // per-cwd config files. Nothing to write into the session cwd.
      files: [],
    };
  },

  parseTranscript(content: string): string {
    return parseTranscript(content);
  },

  exportTranscript(sessionId: string): readonly string[] {
    return ['opencode', 'export', sessionId];
  },

  extractActions(content: string): ActionManifest {
    return extractOpencodeActionsFromContent(content);
  },

  extractTurns(content: string): Turn[] {
    return extractOpencodeTurnsFromContent(content);
  },

  // The bundled plugin: installed once as infrastructure alongside stop.sh.
  // installGlobalPlugin (hooks adapter) writes PLUGIN_SOURCE to
  // hooksDir/opencode-stop.ts and merges that path into the user's global
  // opencode config so opencode loads it on every launch.
  globalPlugin: {
    fileName: 'opencode-stop.ts',
    content: PLUGIN_SOURCE,
  },
} as const;

export const OpenCodeProvider: AgentProvider = opencodeProvider;
