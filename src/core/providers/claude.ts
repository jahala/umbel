import { buildSettingsJson } from '../../adapters/hooks.ts';
import type { AgentProvider, ProviderLaunchSpec } from './types.ts';

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
// ClaudeProvider
// ---------------------------------------------------------------------------

const claudeProvider: AgentProvider = {
  name: 'claude',

  stopEventName: 'Stop',

  buildLaunch(opts): ProviderLaunchSpec {
    const settingsJson = buildSettingsJson(
      opts.allowedTools !== undefined
        ? { hookScriptPath: opts.hookScriptPath, allowedTools: opts.allowedTools }
        : { hookScriptPath: opts.hookScriptPath },
    );

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

  parseTranscript(content: string): string {
    return extractLastAssistantGroup(content);
  },
} as const;

export const ClaudeProvider: AgentProvider = claudeProvider;
