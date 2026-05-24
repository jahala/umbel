import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from './fs-state.ts';

// ---------------------------------------------------------------------------
// STOP_HOOK_SCRIPT — the three-line script installed globally
// ---------------------------------------------------------------------------

// Stop hook script. Receives the lifecycle JSON payload on stdin (per Claude
// Code, Codex, and Gemini conventions — all three include transcript_path).
// Capture transcript_path FIRST, then touch the stop sentinel — waiters that
// watch events/stop are guaranteed to find the path on disk after the mtime
// advances.
export const STOP_HOOK_SCRIPT: string = `#!/usr/bin/env bash
set -euo pipefail
state="\${RCTRL_STATE:?}/sessions/\${RCTRL_SESSION_ID:?}"
mkdir -p "$state/events"
payload=$(cat || true)
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$payload" | jq -r '.transcript_path // empty' > "$state/events/transcript-path" 2>/dev/null || true
fi
touch "$state/events/stop"
date +%s%N >> "$state/events/log"
`;

// ---------------------------------------------------------------------------
// buildSettingsJson — inline JSON for claude's --settings flag
// ---------------------------------------------------------------------------

export function buildSettingsJson(opts: { hookScriptPath: string; allowedTools?: string }): string {
  const hooksBlock = {
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: opts.hookScriptPath,
          },
        ],
      },
    ],
  };

  const settings: Record<string, unknown> = {
    hooks: hooksBlock,
  };

  if (opts.allowedTools !== undefined) {
    settings.permissions = {
      allow: opts.allowedTools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
  }

  return JSON.stringify(settings);
}

// ---------------------------------------------------------------------------
// ensureGlobalHooks — install stop.sh idempotently
// ---------------------------------------------------------------------------

export async function ensureGlobalHooks(
  env: Record<string, string | undefined> = {},
): Promise<{ stopScriptPath: string }> {
  const hooksDir = join(stateDir(env), 'hooks');
  await mkdir(hooksDir, { recursive: true });

  const stopScriptPath = join(hooksDir, 'stop.sh');
  await writeFile(stopScriptPath, STOP_HOOK_SCRIPT, { encoding: 'utf8' });
  await chmod(stopScriptPath, 0o755);

  return { stopScriptPath };
}
