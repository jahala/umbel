import {
  findNodeAtLocation,
  getNodeValue,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import type { ActionManifest, AgentProvider, ProviderLaunchSpec, Turn } from './types.ts';

// ---------------------------------------------------------------------------
// PLUGIN_SOURCE — bundled opencode JS plugin written verbatim to disk.
//
// Runs inside opencode's JS runtime. Cannot import umbel. All logic is inline.
// No-ops unless UMBEL_STATE and UMBEL_SESSION_ID are set (inert in normal use).
// The first event's sessionID is bound to events/worker-session, once; only
// that session's events act afterwards, so an opencode the worker started (it
// inherits UMBEL_*) cannot fire the worker's stop (umbel#118).
// On session.status {type:"busy"}: touches events/turn-start (a submitted
// prompt started a turn, so send can confirm the input landed).
// On session.status {type:"idle"}: writes events/session-id and touches events/stop.
// On permission.updated: touches events/notification (worker blocked on approval).
// ---------------------------------------------------------------------------

export const PLUGIN_SOURCE = `import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function eventsDir() {
  const state = process.env.UMBEL_STATE;
  const umbelSession = process.env.UMBEL_SESSION_ID;
  if (!state || !umbelSession) return null;
  return join(state, "sessions", umbelSession, "events");
}

// Bind the first session the plugin sees, then accept only that id. Nothing
// else runs before the worker's first prompt, so the first event is the
// worker's own. An unbound event (no id yet) keeps the old behaviour.
async function forOwnSession(sessionID) {
  const dir = eventsDir();
  if (!dir) return null;
  await mkdir(dir, { recursive: true });
  const bindPath = join(dir, "worker-session");
  let bound = "";
  try {
    bound = (await readFile(bindPath, "utf8")).trim();
  } catch {
    bound = "";
  }
  if (!bound) {
    if (!sessionID) return dir;
    const tmp = bindPath + ".tmp." + process.pid;
    await writeFile(tmp, String(sessionID), "utf8");
    await rename(tmp, bindPath);
    return dir;
  }
  if (!sessionID || String(sessionID) !== bound) return null;
  return dir;
}

async function logLine(dir) {
  await appendFile(join(dir, "log"), String(Date.now() * 1_000_000) + "\\n", "utf8");
}

async function fireTurnStart(dir) {
  await writeFile(join(dir, "turn-start"), "", "utf8");
  await logLine(dir);
}

async function fireStop(dir, sessionID) {
  await writeFile(join(dir, "session-id"), String(sessionID ?? ""), "utf8");
  await writeFile(join(dir, "stop"), "", "utf8");
  await logLine(dir);
}

async function fireNotification(dir, tool, message) {
  await appendFile(
    join(dir, "notification"),
    JSON.stringify({
      ts: Date.now(),
      hook_event_name: "permission.updated",
      notification_type: "permission",
      message: message ?? null,
      tool_name: tool ?? null,
    }) + "\\n",
    "utf8",
  );
  await logLine(dir);
}

export const Plugin = async () => ({
  event: async ({ event }) => {
    const sessionID = event?.properties?.sessionID;
    const dir = await forOwnSession(sessionID);
    if (!dir) return;
    if (event?.type === "session.status" && event?.properties?.status?.type === "busy") {
      await fireTurnStart(dir);
    }
    if (event?.type === "session.status" && event?.properties?.status?.type === "idle") {
      await fireStop(dir, sessionID);
    }
    if (event?.type === "permission.updated") {
      await fireNotification(dir, event?.properties?.type, event?.properties?.title);
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
// opencodePluginShouldFire — pure gating predicates mirrored in the plugin.
// An event acts only for the session bound at startup (umbel#118, the plugin's
// forOwnSession). With nothing bound, today's behaviour stands. Never throws.
// ---------------------------------------------------------------------------

function pluginEventSessionId(event: JsonObj): string | undefined {
  const props = event.properties;
  if (props === null || typeof props !== 'object') return undefined;
  const id = (props as JsonObj).sessionID;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function pluginOwnsSession(
  event: JsonObj,
  env: Record<string, string | undefined>,
  boundSessionId: string | undefined,
): boolean {
  if (!env?.UMBEL_STATE || !env?.UMBEL_SESSION_ID) return false;
  if (boundSessionId === undefined || boundSessionId === '') return true;
  return pluginEventSessionId(event) === boundSessionId;
}

// session.status idle means the turn ended (Stop).
export function opencodePluginShouldFire(
  event: unknown,
  env: Record<string, string | undefined>,
  boundSessionId?: string,
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
  return pluginOwnsSession(e, env, boundSessionId);
}

// opencode reports status busy when a submitted prompt starts a turn. The
// plugin touches events/turn-start then, so send can prove the input landed
// (umbel#116). Pure + total: never throws; gated like the stop predicate.
export function opencodePluginShouldFireTurnStart(
  event: unknown,
  env: Record<string, string | undefined>,
  boundSessionId?: string,
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
  if (s.type !== 'busy') return false;
  return pluginOwnsSession(e, env, boundSessionId);
}

// A permission event means opencode is BLOCKED asking the user to approve a tool
// call. The v1 plugin `event` stream delivers these as `permission.updated`
// (verified against @opencode-ai/sdk 1.15.12 — `permission.asked` is v2-only).
// Pure + total: never throws; gated like opencodePluginShouldFire.
export function opencodePluginShouldFireNotification(
  event: unknown,
  env: Record<string, string | undefined>,
  boundSessionId?: string,
): boolean {
  if (event === null || typeof event !== 'object') return false;
  const e = event as JsonObj;
  if (e.type !== 'permission.updated') return false;
  return pluginOwnsSession(e, env, boundSessionId);
}

// ---------------------------------------------------------------------------
// removeUmbelPluginEntries — pure + total: drop the plugin entries an older
// umbel registered in the user's opencode.jsonc. They point at
// <UMBEL_STATE>/hooks/opencode-stop.ts, so each state root added one
// (umbel#124); the plugin now auto-loads from the config dir instead. Only the
// legacy entries and their separators are cut, so comments, trailing commas
// and layout survive. A file that is not JSONC is reported, never replaced.
// ---------------------------------------------------------------------------

export type OpencodePluginConfigMigration =
  | { kind: 'unchanged' }
  | { kind: 'write'; content: string }
  | { kind: 'unparsable'; line: number; column: number; reason: string };

const PLUGIN_FILE_NAME = 'opencode-stop.ts';
const LEGACY_PLUGIN_ENTRY = `hooks/${PLUGIN_FILE_NAME}`;

function isLegacyUmbelPluginEntry(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replaceAll('\\', '/');
  return normalized === LEGACY_PLUGIN_ENTRY || normalized.endsWith(`/${LEGACY_PLUGIN_ENTRY}`);
}

export function removeUmbelPluginEntries(existing: string | null): OpencodePluginConfigMigration {
  if (existing === null || existing.trim().length === 0) return { kind: 'unchanged' };

  const errors: ParseError[] = [];
  const root = parseTree(existing, errors, { allowTrailingComma: true });
  const firstError = errors[0];
  if (firstError) {
    return unparsable(existing, firstError.offset, printParseErrorCode(firstError.error));
  }
  if (!root || root.type !== 'object') {
    return unparsable(existing, root?.offset ?? 0, 'the root is not an object');
  }

  const plugins = findNodeAtLocation(root, ['plugin']);
  if (!plugins) return { kind: 'unchanged' };
  if (plugins.type !== 'array')
    return unparsable(existing, plugins.offset, '"plugin" is not an array');

  const stale = (plugins.children ?? [])
    .map((node, index) => ({ index, value: getNodeValue(node) }))
    .filter(({ value }) => isLegacyUmbelPluginEntry(value))
    .map(({ index }) => index);
  if (stale.length === 0) return { kind: 'unchanged' };

  let content = existing;
  // Descending order keeps the lower indices valid as each removal shortens
  // the array.
  for (const index of stale.reverse()) content = removeArrayElement(content, index);
  return { kind: 'write', content };
}

// Cuts one element of the root "plugin" array together with the separator that
// would otherwise dangle. When the element owns its line, the whole line goes,
// so the closing bracket keeps its own line.
function removeArrayElement(text: string, index: number): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const array = root ? findNodeAtLocation(root, ['plugin']) : undefined;
  const children = array?.children ?? [];
  const node = children[index];
  if (node === undefined) return text;

  const start = node.offset;
  const end = node.offset + node.length;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  const lineStop = lineEnd === -1 ? text.length : lineEnd + 1;
  const ownLine = /^[ \t]*$/.test(text.slice(lineStart, start));
  const rest = text.slice(end, lineEnd === -1 ? text.length : lineEnd);

  // The element owns its line: drop the whole line, separator included. The
  // last element's separator is the comma after its predecessor.
  if (ownLine && /^[ \t]*,?[ \t\r]*$/.test(rest)) {
    let withoutLine = text.slice(0, lineStart) + text.slice(lineStop);
    if (children[index + 1] === undefined) {
      const commaAt = previousComma(withoutLine, lineStart - 1);
      if (commaAt >= 0) {
        withoutLine = withoutLine.slice(0, commaAt) + withoutLine.slice(commaAt + 1);
      }
    }
    return withoutLine;
  }

  // Inline, or a comment shares the line: drop the element and one adjacent
  // comma.
  if (children[index + 1] !== undefined) {
    let stop = end;
    while (text[stop] === ' ' || text[stop] === '\t') stop++;
    if (text[stop] === ',') {
      stop++;
      while (text[stop] === ' ' || text[stop] === '\t') stop++;
    }
    return text.slice(0, start) + text.slice(stop);
  }
  const commaAt = previousComma(text, start - 1);
  const from = commaAt === -1 ? start : commaAt;
  return text.slice(0, from) + text.slice(end);
}

function previousComma(text: string, from: number): number {
  let at = from;
  while (at >= 0 && /\s/.test(text[at] ?? '')) at--;
  return text[at] === ',' ? at : -1;
}

function unparsable(text: string, offset: number, reason: string): OpencodePluginConfigMigration {
  const before = text.slice(0, offset);
  return {
    kind: 'unparsable',
    line: before.split('\n').length,
    column: offset - before.lastIndexOf('\n'),
    reason,
  };
}

// ---------------------------------------------------------------------------
// OpenCodeProvider
// ---------------------------------------------------------------------------

const opencodeProvider: AgentProvider = {
  name: 'opencode',
  supportsUnattended: true,
  inheritEnv: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT'],

  stopEventName: 'session.status',

  // The plugin touches this on session.status busy, so send can confirm that a
  // submitted prompt started a turn instead of trusting that it landed.
  turnStartEvent: 'turn-start',

  // opencode's TUI shows no startup dialogs in a fresh cwd.
  startupDialogs: [],

  readyMatch: /Ask anything\.\.\.|Build · /,

  buildLaunch(opts): ProviderLaunchSpec {
    const args: string[] = [];
    if (opts.unattended === true) {
      args.push('--auto');
    }
    if (opts.model !== undefined) {
      args.push('-m', opts.model);
    }
    return {
      bin: 'opencode',
      args,
      // The autoupdate check runs asynchronously after launch and opens a
      // modal that holds the keyboard until it is answered. The first prompt
      // then lands on the modal and no turn starts (umbel#116).
      env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
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

  // opencode binds an unknown -m to whatever provider it falls back to, so a
  // free local model could silently become a paid remote one (umbel#53).
  listModels(bin: string): readonly string[] {
    return [bin, 'models'];
  },

  extractActions(content: string): ActionManifest {
    return extractOpencodeActionsFromContent(content);
  },

  extractTurns(content: string): Turn[] {
    return extractOpencodeTurnsFromContent(content);
  },

  // The bundled plugin: installed once as infrastructure alongside stop.sh.
  // installGlobalPlugin (hooks adapter) writes PLUGIN_SOURCE into the user's
  // global opencode plugin directory, which opencode scans on every launch, and
  // removes the per-state-root entries an older umbel registered (umbel#124).
  globalPlugin: {
    fileName: PLUGIN_FILE_NAME,
    content: PLUGIN_SOURCE,
  },
} as const;

export const OpenCodeProvider: AgentProvider = opencodeProvider;
