import { join } from 'node:path';
import type { AgentProvider, ProviderLaunchSpec } from './types.ts';

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

  buildLaunch(opts): ProviderLaunchSpec {
    const settingsPath = join(opts.cwd, '.gemini', 'settings.json');

    // matcher: "*" is the only supported value for AfterAgent.
    // timeout is in milliseconds (Gemini, unlike Codex which uses seconds).
    const settingsJson = JSON.stringify({
      hooks: {
        AfterAgent: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: opts.hookScriptPath,
                name: 'rctrl-stop',
                timeout: 60000,
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
      bin: 'gemini',
      args,
      env: {},
      files: [{ path: settingsPath, content: settingsJson }],
    };
  },

  parseTranscript(content: string): string {
    return parseGeminiTranscript(content);
  },
} as const;

export const GeminiProvider: AgentProvider = geminiProvider;
