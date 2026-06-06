import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mergeOpencodePluginConfig } from '../core/providers/opencode.ts';
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
// NOTIFY_HOOK_SCRIPT — fired when the worker is BLOCKED waiting on the user
// ---------------------------------------------------------------------------

// The inverse of the Stop hook: the worker needs input (a permission prompt, or
// it has gone idle). Writes the human-readable message to events/notification
// (mtime advance = signal) so a waiter can return reason:'input' WITH the
// question instead of hanging until the timeout. Best-effort message extraction
// across providers (Claude: .message / .notification_type; Codex: .tool_name).
export const NOTIFY_HOOK_SCRIPT: string = `#!/usr/bin/env bash
set -euo pipefail
state="\${RCTRL_STATE:?}/sessions/\${RCTRL_SESSION_ID:?}"
mkdir -p "$state/events"
payload=$(cat || true)
msg=""
if command -v jq >/dev/null 2>&1; then
  msg=$(printf '%s' "$payload" | jq -r '.message // .notification_type // .tool_name // empty' 2>/dev/null || true)
fi
printf '%s' "$msg" > "$state/events/notification"
date +%s%N >> "$state/events/log"
`;

// ---------------------------------------------------------------------------
// buildSettingsJson — inline JSON for claude's --settings flag
// ---------------------------------------------------------------------------

export function buildSettingsJson(opts: {
  hookScriptPath: string;
  notifyScriptPath?: string;
  allowedTools?: string;
}): string {
  const hooksBlock: Record<string, unknown> = {
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

  // Notification hook: fired when Claude is BLOCKED waiting on the user — a tool
  // permission prompt or an idle input wait. Lets a waiter return 'input'
  // instead of hanging to the timeout. Both matchers point at the same script.
  if (opts.notifyScriptPath !== undefined) {
    hooksBlock.Notification = [
      {
        matcher: 'permission_prompt',
        hooks: [{ type: 'command', command: opts.notifyScriptPath }],
      },
      {
        matcher: 'idle_prompt',
        hooks: [{ type: 'command', command: opts.notifyScriptPath }],
      },
    ];
  }

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
): Promise<{ stopScriptPath: string; notifyScriptPath: string }> {
  const hooksDir = join(stateDir(env), 'hooks');
  await mkdir(hooksDir, { recursive: true });

  const stopScriptPath = join(hooksDir, 'stop.sh');
  await writeFile(stopScriptPath, STOP_HOOK_SCRIPT, { encoding: 'utf8' });
  await chmod(stopScriptPath, 0o755);

  const notifyScriptPath = join(hooksDir, 'notify.sh');
  await writeFile(notifyScriptPath, NOTIFY_HOOK_SCRIPT, { encoding: 'utf8' });
  await chmod(notifyScriptPath, 0o755);

  return { stopScriptPath, notifyScriptPath };
}

// ---------------------------------------------------------------------------
// installGlobalPlugin — write a provider's JS plugin and register it in the
// provider's global config. Idempotent. Side effects at the edge.
// ---------------------------------------------------------------------------

export async function installGlobalPlugin(
  spec: { fileName: string; content: string },
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const hooksDir = join(stateDir(env), 'hooks');
  await mkdir(hooksDir, { recursive: true });

  const pluginAbsPath = join(hooksDir, spec.fileName);
  await writeFile(pluginAbsPath, spec.content, { encoding: 'utf8' });

  // Resolve the opencode global config path, respecting XDG_CONFIG_HOME.
  const xdgCfgHome =
    env.XDG_CONFIG_HOME ??
    process.env.XDG_CONFIG_HOME ??
    join(env.HOME ?? process.env.HOME ?? homedir(), '.config');
  const cfgPath = join(xdgCfgHome, 'opencode', 'opencode.jsonc');
  await mkdir(join(xdgCfgHome, 'opencode'), { recursive: true });

  let existing: string | null = null;
  try {
    existing = await readFile(cfgPath, 'utf8');
  } catch {
    // file doesn't exist yet — mergeOpencodePluginConfig handles null
  }

  const merged = mergeOpencodePluginConfig(existing, pluginAbsPath);
  await writeFile(cfgPath, merged, { encoding: 'utf8' });
}
