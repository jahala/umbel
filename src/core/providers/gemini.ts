import { join } from 'node:path';
import type { ActionManifest, AgentProvider, ProviderLaunchSpec, Turn } from './types.ts';

// ---------------------------------------------------------------------------
// Internal JSONL parsing
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Gemini transcript JSONL record types:
//   session_metadata — first line only
//   user            — user turn; content is Array<{text: string}>
//   gemini          — model turn; same shape as user
//   message_update  — async token/update record appended after a gemini record
//
// We want the LAST `gemini` record's text. Walk backward, skip
// message_update records (they trail the gemini record they annotate), stop
// at the last gemini record.
function parseGeminiTranscript(content: string): string {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return '';

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const parsed = parseLine(raw);
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as JsonObj;

    if (obj.type !== 'gemini') continue;

    // content is Array<{text: string}>
    const contentArr = obj.content;
    if (!Array.isArray(contentArr)) return '';
    const parts: string[] = [];
    for (const item of contentArr) {
      if (item !== null && typeof item === 'object') {
        const block = item as JsonObj;
        if (typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
    return parts.join('');
  }

  return '';
}

// ---------------------------------------------------------------------------
// Action extraction (pure, defensive)
// ---------------------------------------------------------------------------
//
// CONFIDENCE LEVEL: medium. We know the `gemini` / `user` / `message_update`
// envelope (used by parseTranscript + verified by fake-gemini.sh). Tool-call
// records are *inferred* by analogy — handled if present, gracefully ignored
// if not. Final-message and turn-count remain reliable.
//
// TODO(b3-gemini): verify function_call / function_response record shape
// against a real Gemini CLI transcript and refine field extraction.

function pushUnique(arr: string[], val: string): void {
  if (!arr.includes(val)) arr.push(val);
}

function extractToolCallFromBlock(
  block: JsonObj,
  toolsUsed: Record<string, number>,
  filesRead: string[],
  filesEdited: string[],
  filesWritten: string[],
  bashCommands: string[],
): void {
  // Accept either { name, args } or { function_call: { name, args } }.
  let toolName: string | undefined;
  let argsField: JsonObj | null = null;

  if (typeof block.name === 'string') {
    toolName = block.name;
    if (block.args !== undefined && typeof block.args === 'object')
      argsField = block.args as JsonObj;
    else if (block.input !== undefined && typeof block.input === 'object')
      argsField = block.input as JsonObj;
  } else if (block.function_call !== undefined && typeof block.function_call === 'object') {
    const fc = block.function_call as JsonObj;
    if (typeof fc.name === 'string') {
      toolName = fc.name;
      if (fc.args !== undefined && typeof fc.args === 'object') argsField = fc.args as JsonObj;
    }
  }

  if (toolName === undefined) return;
  toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;

  if (argsField === null) return;
  const filePath = typeof argsField.file_path === 'string' ? argsField.file_path : undefined;
  const command = typeof argsField.command === 'string' ? argsField.command : undefined;
  if (toolName === 'Read' && filePath !== undefined) pushUnique(filesRead, filePath);
  else if ((toolName === 'Edit' || toolName === 'MultiEdit') && filePath !== undefined)
    pushUnique(filesEdited, filePath);
  else if (toolName === 'Write' && filePath !== undefined) pushUnique(filesWritten, filePath);
  else if (toolName === 'Bash' && command !== undefined) bashCommands.push(command);
}

export function extractGeminiActionsFromContent(content: string): ActionManifest {
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

    if (obj.type === 'gemini') {
      turnCount++;
      // gemini.content[] may contain function_call blocks alongside text blocks.
      const contentArr = obj.content;
      if (Array.isArray(contentArr)) {
        for (const item of contentArr) {
          if (item !== null && typeof item === 'object') {
            extractToolCallFromBlock(
              item as JsonObj,
              toolsUsed,
              filesRead,
              filesEdited,
              filesWritten,
              bashCommands,
            );
          }
        }
      }
      continue;
    }

    // Top-level function_call records (alternative shape).
    if (obj.type === 'function_call') {
      extractToolCallFromBlock(obj, toolsUsed, filesRead, filesEdited, filesWritten, bashCommands);
    }

    // Top-level function_response with error.
    if (obj.type === 'function_response' && obj.is_error === true) {
      const errMsg =
        typeof obj.response === 'string'
          ? obj.response
          : typeof obj.error === 'string'
            ? obj.error
            : typeof obj.message === 'string'
              ? obj.message
              : '';
      if (errMsg.length > 0) errors.push(errMsg);
    }
  }

  return {
    toolsUsed,
    filesRead,
    filesEdited,
    filesWritten,
    bashCommands,
    errors,
    finalMessage: parseGeminiTranscript(content),
    turnCount,
  };
}

// Pure: split Gemini transcript into completed turns. Each `gemini` record is
// one turn (Gemini, unlike Claude/Codex, doesn't have a separate
// "task_complete" event — the gemini record itself IS the boundary). The
// turn's text is the concatenation of text blocks in that record's content
// array. Pure — never throws; returns [] for empty/malformed input.
export function extractGeminiTurnsFromContent(content: string): Turn[] {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const turns: Turn[] = [];
  let idx = 0;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as JsonObj;
    if (obj.type !== 'gemini') continue;

    const contentArr = obj.content;
    let text = '';
    if (Array.isArray(contentArr)) {
      const parts: string[] = [];
      for (const item of contentArr) {
        if (item !== null && typeof item === 'object') {
          const block = item as JsonObj;
          if (typeof block.text === 'string') parts.push(block.text);
        }
      }
      text = parts.join('');
    }
    turns.push({ index: idx, text });
    idx++;
  }
  return turns;
}

// ---------------------------------------------------------------------------
// GeminiProvider
// ---------------------------------------------------------------------------

// NOTE: Gemini has no `--settings '<inline-json>'` equivalent (unlike Claude).
// The only way to install hooks is to write `<cwd>/.gemini/settings.json` to
// disk before launch. The operations layer writes the file (via launchSpec.files)
// and removes it on session kill (via meta.providerFiles). This overwrites any
// existing project-level `.gemini/settings.json` — known v3 limitation; user's
// existing project settings are not merged. Document before widening to shared
// codebases.
const geminiProvider: AgentProvider = {
  name: 'gemini',

  stopEventName: 'AfterAgent',

  // Gemini 0.44's TUI shows a folder-trust prompt on first launch in a fresh
  // cwd (verified against the real binary): "Do you trust the files in this
  // folder?" with options 1. Trust folder / 2. Trust parent / 3. Don't. Default
  // ● is option 1 (trust this folder) — a single Enter accepts it, which also
  // enables hook/MCP/settings loading for the dir. The "update available"
  // notice is a non-interactive info box (no dismissal). Wording ("the files in
  // this folder") differs from claude/codex, so it needs its own matcher.
  //
  // No readyMatch: gemini's welcome banner ("Gemini CLI v…", "Tips for getting
  // started") renders ABOVE the trust dialog in the same frame, so a
  // banner-based readyMatch could short-circuit before the dialog is dismissed.
  // With a single dialog the loop already exits the instant it fires, so the
  // fast-path optimization isn't needed; an already-trusted spawn just polls to
  // the timeout (correct, only slightly slower).
  //
  // NOTE: gemini must already be authenticated (a one-time `gemini` → Sign in
  // with Google). On an unauthenticated machine an auth-method prompt appears
  // AFTER trust; umbel does not auto-dismiss it (completing OAuth needs a
  // browser, and silently picking an auth method is a poor default).
  startupDialogs: [{ match: /trust the files in this folder/i, keys: ['Enter'] }],

  buildLaunch(opts): ProviderLaunchSpec {
    const settingsPath = join(opts.cwd, '.gemini', 'settings.json');

    // matcher: "*" is the only supported value for AfterAgent.
    // timeout is in milliseconds (Gemini, unlike Codex which uses seconds).
    const hooks: Record<string, unknown> = {
      AfterAgent: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: opts.hookScriptPath,
              name: 'umbel-stop',
              timeout: 60000,
            },
          ],
        },
      ],
    };
    // Notification (notification_type ToolPermission) fires when Gemini shows a
    // tool-permission prompt — the worker is BLOCKED. Verified against gemini
    // 0.44.0; matcher has no effect on Notification so it is omitted. timeout ms.
    if (opts.notifyScriptPath !== undefined) {
      hooks.Notification = [
        {
          hooks: [
            {
              type: 'command',
              command: opts.notifyScriptPath,
              name: 'umbel-notify',
              timeout: 60000,
            },
          ],
        },
      ];
    }
    const settingsJson = JSON.stringify({ hooks });

    const args: string[] = [];
    if (opts.model !== undefined) {
      args.push('--model', opts.model);
    }

    return {
      bin: 'gemini',
      args,
      env: {},
      files: [{ path: settingsPath, content: settingsJson }],
    };
  },

  parseTranscript(content: string): string {
    return parseGeminiTranscript(content);
  },

  extractActions(content: string): ActionManifest {
    return extractGeminiActionsFromContent(content);
  },

  extractTurns(content: string): Turn[] {
    return extractGeminiTurnsFromContent(content);
  },
} as const;

export const GeminiProvider: AgentProvider = geminiProvider;
