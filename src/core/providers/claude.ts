import { buildSettingsJson } from '../../adapters/hooks.ts';
import type { ActionManifest, AgentProvider, ProviderLaunchSpec, Turn } from './types.ts';

// Re-export buildSettingsJson for backward compatibility during refactor.
// Delete after operations layer is fully updated.
export { buildSettingsJson };

// ---------------------------------------------------------------------------
// Internal JSONL parsing — extracted from adapters/jsonl.ts logic
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item !== null && typeof item === 'object') {
        const block = item as JsonObj;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

function extractText(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const obj = entry as JsonObj;

  // Shape A: { message: { role: 'assistant', content: [...] } }
  const msgField = obj.message;
  if (msgField !== null && typeof msgField === 'object') {
    const msg = msgField as JsonObj;
    if (msg.role === 'assistant') {
      return extractTextFromContent(msg.content);
    }
  }

  // Shape B: { role: 'assistant', content: '...' or [...] }
  if (obj.role === 'assistant') {
    return extractTextFromContent(obj.content);
  }

  return null;
}

function isAssistantEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const obj = entry as JsonObj;

  // Shape A: message.role === 'assistant'
  const msg = obj.message;
  if (msg !== null && typeof msg === 'object') {
    const m = msg as JsonObj;
    if (m.role === 'assistant') return true;
  }

  // Shape B: role === 'assistant'
  if (obj.role === 'assistant') return true;

  // Shape C: type === 'assistant'
  if (obj.type === 'assistant') return true;

  return false;
}

// Extract the last assistant group from Claude JSONL content.
// Mirrors readLastAssistantGroup in adapters/jsonl.ts.
function extractLastAssistantGroup(content: string): string {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return '';

  const entries: unknown[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    // Skip malformed lines (non-throwing — parseTranscript is pure)
    if (parsed !== null) {
      entries.push(parsed);
    }
  }

  // Claude appends metadata entries (system, last-prompt, ai-title,
  // permission-mode) AFTER the assistant response. Find the last assistant
  // entry's index, then walk backward while still in an assistant run.
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isAssistantEntry(entries[i])) {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) return '';

  const lastGroup: unknown[] = [];
  for (let i = lastAssistantIdx; i >= 0; i--) {
    const entry = entries[i];
    if (isAssistantEntry(entry)) {
      lastGroup.unshift(entry);
    } else {
      break;
    }
  }

  if (lastGroup.length === 0) return '';

  const textParts: string[] = [];
  for (const entry of lastGroup) {
    const t = extractText(entry);
    if (t !== null) {
      textParts.push(t);
    }
  }

  return textParts.join('');
}

// ---------------------------------------------------------------------------
// Action / Turn extraction (pure)
// ---------------------------------------------------------------------------

function getStopReason(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const obj = entry as JsonObj;
  // Shape A: { message: { stop_reason: ... } }
  const msg = obj.message;
  if (msg !== null && typeof msg === 'object') {
    const m = msg as JsonObj;
    if (typeof m.stop_reason === 'string') return m.stop_reason;
  }
  // Shape B: top-level stop_reason
  if (typeof obj.stop_reason === 'string') return obj.stop_reason;
  return undefined;
}

function getContentBlocks(entry: unknown): readonly unknown[] {
  if (entry === null || typeof entry !== 'object') return [];
  const obj = entry as JsonObj;
  // Shape A: message.content[]
  const msg = obj.message;
  if (msg !== null && typeof msg === 'object') {
    const m = msg as JsonObj;
    if (Array.isArray(m.content)) return m.content;
  }
  // Shape B: content[] at top level
  if (Array.isArray(obj.content)) return obj.content;
  return [];
}

function parseAllEntries(content: string): unknown[] {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries: unknown[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed !== null) entries.push(parsed);
  }
  return entries;
}

function pushUnique(arr: string[], val: string): void {
  if (!arr.includes(val)) arr.push(val);
}

function extractToolResultErrorText(block: JsonObj): string {
  // Content may be a string OR an array of {type:'text', text:string} blocks.
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    const parts: string[] = [];
    for (const sub of block.content) {
      if (sub !== null && typeof sub === 'object') {
        const s = sub as JsonObj;
        if (s.type === 'text' && typeof s.text === 'string') parts.push(s.text);
      }
    }
    return parts.join('');
  }
  return '';
}

// Pure: extract a normalized action manifest from a Claude JSONL transcript.
// Total — never throws on malformed input; missing fields produce empty
// counts/lists, not exceptions.
export function extractActionsFromContent(content: string): ActionManifest {
  const entries = parseAllEntries(content);

  const toolsUsed: Record<string, number> = {};
  const filesRead: string[] = [];
  const filesEdited: string[] = [];
  const filesWritten: string[] = [];
  const bashCommands: string[] = [];
  const errors: string[] = [];
  let turnCount = 0;

  for (const entry of entries) {
    if (isAssistantEntry(entry) && getStopReason(entry) === 'end_turn') {
      turnCount++;
    }

    for (const block of getContentBlocks(entry)) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as JsonObj;

      if (b.type === 'tool_use' && typeof b.name === 'string') {
        const toolName = b.name;
        toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;

        const input = b.input;
        if (input !== null && typeof input === 'object') {
          const inp = input as JsonObj;
          const filePath = typeof inp.file_path === 'string' ? inp.file_path : undefined;
          const command = typeof inp.command === 'string' ? inp.command : undefined;

          if (toolName === 'Read' && filePath !== undefined) pushUnique(filesRead, filePath);
          else if ((toolName === 'Edit' || toolName === 'MultiEdit') && filePath !== undefined)
            pushUnique(filesEdited, filePath);
          else if (toolName === 'Write' && filePath !== undefined)
            pushUnique(filesWritten, filePath);
          else if (toolName === 'Bash' && command !== undefined) bashCommands.push(command);
        }
      }

      if (b.type === 'tool_result' && b.is_error === true) {
        const errMsg = extractToolResultErrorText(b);
        if (errMsg.length > 0) errors.push(errMsg);
      }
    }
  }

  return {
    toolsUsed,
    filesRead,
    filesEdited,
    filesWritten,
    bashCommands,
    errors,
    finalMessage: extractLastAssistantGroup(content),
    turnCount,
  };
}

// Pure: split the transcript into completed turns. Each turn's `text` is the
// content of the assistant entry that carried stop_reason: end_turn (i.e. the
// turn's final message — matches parseTranscript's notion of "final"). Earlier
// assistant entries within the same turn (those that carried tool_use and
// ended in stop_reason: tool_use) are not surfaced as their own turns.
export function extractTurnsFromContent(content: string): Turn[] {
  const entries = parseAllEntries(content);
  const turns: Turn[] = [];
  let idx = 0;
  for (const entry of entries) {
    if (isAssistantEntry(entry) && getStopReason(entry) === 'end_turn') {
      const text = extractText(entry) ?? '';
      turns.push({ index: idx, text });
      idx++;
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// ClaudeProvider
// ---------------------------------------------------------------------------

const claudeProvider: AgentProvider = {
  name: 'claude',

  stopEventName: 'Stop',

  // Real claude shows a workspace-trust prompt on first launch in a fresh cwd.
  // Default option is "Yes, I trust this folder" — a single Enter dismisses it.
  startupDialogs: [{ match: /trust this folder|trust this directory/i, keys: ['Enter'] }],
  readyMatch: /Try |for shortcuts|│/,

  buildLaunch(opts): ProviderLaunchSpec {
    const settingsJson = buildSettingsJson({
      hookScriptPath: opts.hookScriptPath,
      ...(opts.notifyScriptPath !== undefined ? { notifyScriptPath: opts.notifyScriptPath } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    });

    const args: string[] = ['--settings', settingsJson];
    if (opts.model !== undefined) {
      args.push('--model', opts.model);
    }

    return {
      bin: 'claude',
      args,
      env: {},
      files: [],
    };
  },

  // The interactive Claude TUI auths via subscription, or via
  // ANTHROPIC_AUTH_TOKEN for a custom Anthropic-compatible endpoint. An
  // ANTHROPIC_API_KEY the worker merely INHERITED then both contradicts that
  // token and trips Claude Code's "Detected a custom API key… use this key?"
  // prompt — wedging the worker. The two are mutually exclusive, so when a
  // custom AUTH_TOKEN is present we drop the API key.
  reconcileEnv(env: Record<string, string>): Record<string, string> {
    if (!env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY === undefined) return env;
    const reconciled = { ...env };
    delete reconciled.ANTHROPIC_API_KEY;
    return reconciled;
  },

  parseTranscript(content: string): string {
    return extractLastAssistantGroup(content);
  },

  extractActions(content: string): ActionManifest {
    return extractActionsFromContent(content);
  },

  extractTurns(content: string): Turn[] {
    return extractTurnsFromContent(content);
  },
} as const;

export const ClaudeProvider: AgentProvider = claudeProvider;
