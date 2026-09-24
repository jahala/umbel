import type { ActionManifest, AgentProvider, ProviderLaunchSpec, Turn } from './types.ts';

// ---------------------------------------------------------------------------
// Internal JSONL parsing: agy's stream-json print mode (umbel#113)
// ---------------------------------------------------------------------------
// One JSON object per line, `event` key first: `init` at startup, one
// `step_update` per step, one `result` per turn. Verified against the
// installed Antigravity CLI 1.2.10 (fixtures in test/fixtures/agy/).
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

function parseLine(raw: string): JsonObj | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as JsonObj;
  } catch {
    return null;
  }
}

function asObj(value: unknown): JsonObj | null {
  return value !== null && typeof value === 'object' ? (value as JsonObj) : null;
}

function stepUpdateOf(line: JsonObj): JsonObj | null {
  if (line.event !== 'step_update') return null;
  return asObj(line.step_update);
}

function resultOf(line: JsonObj): JsonObj | null {
  if (line.event !== 'result') return null;
  return asObj(line.result);
}

// The newest `result` event in the transcript, or null if none has landed
// yet. Exactly one per turn, so "newest" is just the last one on disk.
function newestResult(content: string): JsonObj | null {
  let newest: JsonObj | null = null;
  for (const line of content.split('\n')) {
    const obj = parseLine(line);
    if (obj === null) continue;
    const result = resultOf(obj);
    if (result !== null) newest = result;
  }
  return newest;
}

// A result's own text: SUCCESS carries it in `response`, which agy ends with a
// newline; ERROR carries it in `error`, the turn's only text, as claude's
// API-error line stands in for its reply.
function resultText(result: JsonObj): string {
  if (result.status === 'SUCCESS') {
    const response = typeof result.response === 'string' ? result.response : '';
    return response.replace(/\n+$/, '');
  }
  if (result.status === 'ERROR') {
    return typeof result.error === 'string' ? result.error : '';
  }
  return '';
}

export function parseAgyTranscript(content: string): string {
  const result = newestResult(content);
  return result === null ? '' : resultText(result);
}

// A turn is open only while the newest of {a user_input step_update, a
// result} is the user_input step: agy has taken the prompt but not yet
// closed the turn. No markers, or an unparseable transcript, cannot prove a
// turn open, so both answer true: a read must never stall on an unrecognised
// shape (umbel#86).
export function agyTurnEnded(content: string): boolean {
  let newest: 'user_input' | 'result' | undefined;
  for (const line of content.split('\n')) {
    const obj = parseLine(line);
    if (obj === null) continue;
    const su = stepUpdateOf(obj);
    if (su !== null && su.step_type === 'user_input') {
      newest = 'user_input';
      continue;
    }
    if (resultOf(obj) !== null) newest = 'result';
  }
  return newest !== 'user_input';
}

export function extractAgyTurnsFromContent(content: string): Turn[] {
  const turns: Turn[] = [];
  let idx = 0;
  for (const line of content.split('\n')) {
    const obj = parseLine(line);
    if (obj === null) continue;
    const result = resultOf(obj);
    if (result === null) continue;
    turns.push({ index: idx, text: resultText(result) });
    idx++;
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Action extraction (pure, defensive)
// ---------------------------------------------------------------------------
//
// Tool parameter names verified against real 1.2.10 transcripts: run_command
// CommandLine, view_file AbsolutePath, write_to_file and replace_file_content
// TargetFile. multi_replace_file_content and sed_file are unverified; their
// TargetFile is taken as an edited file because they share the edit family.

function pushUnique(arr: string[], val: string): void {
  if (!arr.includes(val)) arr.push(val);
}

const EDIT_FAMILY_TOOLS = new Set([
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
]);

export function extractAgyActionsFromContent(content: string): ActionManifest {
  const toolsUsed: Record<string, number> = {};
  const filesRead: string[] = [];
  const filesEdited: string[] = [];
  const filesWritten: string[] = [];
  const bashCommands: string[] = [];
  const errors: string[] = [];
  let turnCount = 0;

  for (const line of content.split('\n')) {
    const obj = parseLine(line);
    if (obj === null) continue;

    const su = stepUpdateOf(obj);
    if (su !== null && su.step_type === 'tool' && (su.state === 'DONE' || su.state === 'ERROR')) {
      const toolName = typeof su.tool_name === 'string' ? su.tool_name : undefined;
      if (toolName !== undefined) {
        toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;
      }

      const toolInfo = asObj(su.tool_info);

      if (su.state === 'ERROR') {
        const error = toolInfo !== null ? asObj(toolInfo.error) : null;
        const message = error !== null && typeof error.message === 'string' ? error.message : '';
        if (message.length > 0) errors.push(message);
      } else {
        // An ERROR step touched nothing, so only a DONE step lands here.
        const params = toolInfo !== null ? asObj(toolInfo.parameters) : null;
        if (params !== null && toolName !== undefined) {
          if (toolName === 'run_command' && typeof params.CommandLine === 'string') {
            bashCommands.push(params.CommandLine);
          } else if (toolName === 'view_file' && typeof params.AbsolutePath === 'string') {
            pushUnique(filesRead, params.AbsolutePath);
          } else if (toolName === 'write_to_file' && typeof params.TargetFile === 'string') {
            pushUnique(filesWritten, params.TargetFile);
          } else if (EDIT_FAMILY_TOOLS.has(toolName) && typeof params.TargetFile === 'string') {
            pushUnique(filesEdited, params.TargetFile);
          }
        }
      }
      continue;
    }

    const result = resultOf(obj);
    if (result !== null) {
      turnCount++;
      if (result.status === 'ERROR') {
        const errorText = typeof result.error === 'string' ? result.error : '';
        if (errorText.length > 0) errors.push(errorText);
      }
      const denied = result.denied_actions;
      if (Array.isArray(denied)) {
        for (const entry of denied) {
          const e = asObj(entry);
          const action = e !== null && typeof e.action === 'string' ? e.action : undefined;
          if (action !== undefined) errors.push(`permission denied: ${action}`);
        }
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
    finalMessage: parseAgyTranscript(content),
    turnCount,
  };
}

// ---------------------------------------------------------------------------
// AgyProvider
// ---------------------------------------------------------------------------

const agyProvider: AgentProvider = {
  name: 'agy',
  supportsUnattended: true,

  // Informational: agy has no hooks. The stream wrapper runs stop.sh on each
  // line starting with stream.turnEndPrefix.
  stopEventName: 'result',

  stream: {
    // One line even for a multi-line prompt: JSON.stringify escapes newlines.
    encodePrompt(prompt: string): string {
      return JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } });
    },
    turnEndPrefix: '{"event":"result"',
  },

  readyMatch: /^\{"event":"init"/m,

  // Whole-line, taken from the installed 1.2.10 binary
  // (test/fixtures/sign-in/agy-1.2.10-sign-in.txt). agy then waits on stderr
  // for a pasted authorization code.
  signInMatch: /^Authentication required\. Please visit the URL to log in:$/m,

  buildLaunch(opts): ProviderLaunchSpec {
    const args: string[] = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--add-dir',
      opts.realCwd ?? opts.cwd,
    ];
    if (opts.unattended === true) {
      args.push('--dangerously-skip-permissions');
    }
    if (opts.model !== undefined) {
      args.push('--model', opts.model);
    }
    // -p takes an argument; the empty one leaves the prompts to stdin, which
    // is how the stream wrapper feeds each turn.
    args.push('-p=');

    return {
      bin: 'agy',
      args,
      env: {},
      files: [],
    };
  },

  parseTranscript(content: string): string {
    return parseAgyTranscript(content);
  },

  turnEnded(content: string): boolean {
    return agyTurnEnded(content);
  },

  extractActions(content: string): ActionManifest {
    return extractAgyActionsFromContent(content);
  },

  extractTurns(content: string): Turn[] {
    return extractAgyTurnsFromContent(content);
  },

  // `agy models` prints `<id>\t<label>` lines; spawn takes the first token
  // and refuses a --model that isn't among them.
  listModels(bin: string): readonly string[] {
    return [bin, 'models'];
  },
} as const;

export const AgyProvider: AgentProvider = agyProvider;
