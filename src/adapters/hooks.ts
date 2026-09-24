import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpencodeConfigUnparsableError } from '../core/errors.ts';
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
// EXEC_WRAPPER_SCRIPT — launches the worker and records how it ended
// ---------------------------------------------------------------------------

// The worker's pane runs this with the name of the tmux buffer holding the
// worker's environment, then the worker's argv. The environment never rides an
// argv (umbel#93): the buffer is read through a pipe and deleted, every variable
// the pane inherited is dropped except the ones tmux sets to describe the pane,
// and the worker's own exports are applied, all with builtins, so no process
// the wrapper starts carries a value on its command line.
//
// Installed as launch.sh, not exec.sh: every spawn rewrites its wrapper, and an
// older umbel still running (a long-lived MCP server) owns exec.sh. Sharing one
// file would hand each version the other's argv.
//
// It then writes events/exit ({"exitCode":N} or {"signal":"SIGTERM"}) when the
// process ends, and ends the same way, so tmux's own pane status still agrees. tmux builds differ in
// whether they record a dead pane's status at all (ubuntu's 3.4 did not,
// umbel#91); this record does not depend on one.
//
// The worker runs as a background job so the wrapper's traps fire while it
// waits; `<&0` keeps the pane's tty as its stdin. HUP and TERM are forwarded and
// remembered, so a worker that exits cleanly after one still reads as ended by
// it. USR1 and USR2 are forwarded only. The events dir is never created here:
// a purged session must stay purged. INT and QUIT come from the tty to the
// whole process group, so the wrapper just survives them: a no-op trap, which
// unlike an ignored signal is not inherited by the worker.
export const EXEC_WRAPPER_SCRIPT: string = `#!/usr/bin/env bash
buffer=$1
shift
if ! worker_env=$(tmux show-buffer -b "$buffer"); then
  echo "umbel: the worker's environment was not handed over" >&2
  exit 1
fi
tmux delete-buffer -b "$buffer" 2>/dev/null
while IFS= read -r name; do
  case $name in
    TERM | TERM_PROGRAM | TERM_PROGRAM_VERSION | COLORTERM | TMUX | TMUX_PANE) ;;
    *) unset "$name" 2>/dev/null ;;
  esac
done < <(compgen -e)
eval "$worker_env"
events="\${UMBEL_STATE:?}/sessions/\${UMBEL_SESSION_ID:?}/events"
child=''
trapped=''
forward() {
  if [ -n "$child" ]; then kill -s "$1" "$child" 2>/dev/null || true; fi
}
for sig in HUP TERM; do
  trap "trapped=$sig; forward $sig" "$sig"
done
for sig in USR1 USR2; do
  trap "forward $sig" "$sig"
done
trap ':' INT QUIT
"$@" <&0 &
child=$!
# A trapped signal interrupts wait before the worker is gone; wait again until
# it is, then once more for the status bash kept for it.
while wait "$child"; [ $? -gt 128 ] && kill -0 "$child" 2>/dev/null; do :; done
wait "$child" 2>/dev/null
status=$?
signal=''
if [ "$status" -gt 128 ] && name=$(kill -l "$((status - 128))" 2>/dev/null); then
  signal="SIG\${name#SIG}"
elif [ -n "$trapped" ]; then
  signal="SIG$trapped"
fi
if [ -d "$events" ]; then
  if [ -n "$signal" ]; then
    printf '{"signal":"%s"}' "$signal" > "$events/.exit.tmp.$$"
  else
    printf '{"exitCode":%d}' "$status" > "$events/.exit.tmp.$$"
  fi
  mv -f "$events/.exit.tmp.$$" "$events/exit" 2>/dev/null
fi
if [ -n "$signal" ]; then
  trap - "\${signal#SIG}"
  kill -s "\${signal#SIG}" $$
fi
exit "$status"
`;

// ---------------------------------------------------------------------------
// STREAM_WRAPPER_SCRIPT — runs a worker that speaks a line protocol (umbel#113)
// ---------------------------------------------------------------------------

// usage: stream.sh <transcript> <turn-end-prefix> <stop-hook> <bin> [args...]
// The pane's tty goes non-canonical and silent first: a canonical tty on macOS
// holds a line to 1024 bytes, and send types each prompt as one line. Each
// line the worker prints is appended to the transcript, then shown on the
// pane; a line opening with the turn-end prefix runs the stop hook with the
// transcript's path, so the stop always follows the turn's last line on disk.
// pipefail keeps the worker's own exit status for launch.sh to record.
export const STREAM_WRAPPER_SCRIPT: string = `#!/usr/bin/env bash
set -o pipefail
transcript=$1
marker=$2
stop=$3
shift 3
stty -icanon -echo 2>/dev/null
"$@" | while IFS= read -r line || [ -n "$line" ]; do
  printf '%s\n' "$line" >> "$transcript"
  printf '%s\n' "$line"
  case $line in
    "$marker"*) jq -cn --arg p "$transcript" '{transcript_path: $p}' | "$stop" ;;
  esac
done
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

export async function ensureGlobalHooks(env: Record<string, string | undefined> = {}): Promise<{
  stopScriptPath: string;
  notifyScriptPath: string;
  statusLineScriptPath: string;
  launchScriptPath: string;
  streamScriptPath: string;
}> {
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

  const launchScriptPath = join(hooksDir, 'launch.sh');
  await writeFile(launchScriptPath, EXEC_WRAPPER_SCRIPT, { encoding: 'utf8' });
  await chmod(launchScriptPath, 0o755);

  const streamScriptPath = join(hooksDir, 'stream.sh');
  await writeFile(streamScriptPath, STREAM_WRAPPER_SCRIPT, { encoding: 'utf8' });
  await chmod(streamScriptPath, 0o755);

  return {
    stopScriptPath,
    notifyScriptPath,
    statusLineScriptPath,
    launchScriptPath,
    streamScriptPath,
  };
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
  if (merged.kind === 'unparsable') {
    throw new OpencodeConfigUnparsableError(cfgPath, merged.line, merged.column, merged.reason);
  }
  if (merged.kind === 'write') await writeFile(cfgPath, merged.content, { encoding: 'utf8' });
}
