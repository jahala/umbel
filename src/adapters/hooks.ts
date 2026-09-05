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
state="\${UMBEL_STATE:?}/sessions/\${UMBEL_SESSION_ID:?}"
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
// it has gone idle). APPENDS one JSON line per event to events/notification
// ({ts, hook_event_name, notification_type, message, tool_name}) — append, not
// overwrite, so a transient permission prompt is never clobbered by a later idle
// ping. mtime advance = signal; core/notification.ts classifies the latest line.
export const NOTIFY_HOOK_SCRIPT: string = `#!/usr/bin/env bash
set -euo pipefail
state="\${UMBEL_STATE:?}/sessions/\${UMBEL_SESSION_ID:?}"
mkdir -p "$state/events"
payload=$(cat || true)
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$payload" | jq -c '{ts: (now*1000|floor), hook_event_name: (.hook_event_name // null), notification_type: (.notification_type // null), message: (.message // null), tool_name: (.tool_name // null)}' >> "$state/events/notification" 2>/dev/null || true
else
  printf '{"ts":%s}\\n' "$(( $(date +%s) * 1000 ))" >> "$state/events/notification"
fi
date +%s%N >> "$state/events/log"
`;

// ---------------------------------------------------------------------------
// STATUSLINE_SCRIPT — captures the statusLine payload as structured state
// ---------------------------------------------------------------------------

// claude runs statusLine on every render and hands it a JSON snapshot on stdin
// that carries subscription rate-limit usage. Writing it to the events dir turns
// a presentational pane line into state a caller can branch on, without
// scraping the pane. Rendered output is deliberately empty: nobody reads a
// headless worker's status line, and printing to it would only churn the pane
// that idle-detection watches.
export const STATUSLINE_SCRIPT: string = `#!/usr/bin/env bash
set -euo pipefail
state="\${UMBEL_STATE:?}/sessions/\${UMBEL_SESSION_ID:?}"
mkdir -p "$state/events"
# Rename into place so a concurrent reader never sees a half-written file.
cat > "$state/events/quota.part"
mv -f "$state/events/quota.part" "$state/events/quota"
`;

// ---------------------------------------------------------------------------
// buildSettingsJson — inline JSON for claude's --settings flag
// ---------------------------------------------------------------------------

export function buildSettingsJson(opts: {
  hookScriptPath: string;
  notifyScriptPath?: string;
  allowedTools?: string;
  permissionMode?: string;
  unattended?: boolean;
  statusLineScriptPath?: string;
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

  if (opts.statusLineScriptPath !== undefined) {
    settings.statusLine = { type: 'command', command: opts.statusLineScriptPath };
  }

  // Delivered through --settings rather than --dangerously-skip-permissions:
  // same effect, but it reuses the config channel umbel already owns and skips
  // that flag's separate --allow-dangerously-skip-permissions gate. An explicit
  // permissionMode still wins — the caller asked for a specific posture.
  const defaultMode =
    opts.permissionMode ?? (opts.unattended === true ? 'bypassPermissions' : undefined);

  if (opts.allowedTools !== undefined || defaultMode !== undefined) {
    const permissions: Record<string, unknown> = {};
    if (opts.allowedTools !== undefined) {
      permissions.allow = opts.allowedTools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (defaultMode !== undefined) {
      permissions.defaultMode = defaultMode;
    }
    settings.permissions = permissions;
  }

  return JSON.stringify(settings);
}

// ---------------------------------------------------------------------------
// ensureGlobalHooks — install stop.sh idempotently
// ---------------------------------------------------------------------------

export async function ensureGlobalHooks(
  env: Record<string, string | undefined> = {},
): Promise<{ stopScriptPath: string; notifyScriptPath: string; statusLineScriptPath: string }> {
  const hooksDir = join(stateDir(env), 'hooks');
  await mkdir(hooksDir, { recursive: true });

  const stopScriptPath = join(hooksDir, 'stop.sh');
  await writeFile(stopScriptPath, STOP_HOOK_SCRIPT, { encoding: 'utf8' });
  await chmod(stopScriptPath, 0o755);

  const notifyScriptPath = join(hooksDir, 'notify.sh');
  await writeFile(notifyScriptPath, NOTIFY_HOOK_SCRIPT, { encoding: 'utf8' });
  await chmod(notifyScriptPath, 0o755);

  const statusLineScriptPath = join(hooksDir, 'statusline.sh');
  await writeFile(statusLineScriptPath, STATUSLINE_SCRIPT, { encoding: 'utf8' });
  await chmod(statusLineScriptPath, 0o755);

  return { stopScriptPath, notifyScriptPath, statusLineScriptPath };
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
