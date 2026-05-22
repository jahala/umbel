import { join } from 'node:path';
import type { AgentProvider, ProviderLaunchSpec } from './types.ts';

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
// CodexProvider
// ---------------------------------------------------------------------------

const codexProvider: AgentProvider = {
  name: 'codex',

  stopEventName: 'Stop',

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
} as const;

export const CodexProvider: AgentProvider = codexProvider;
