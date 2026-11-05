#!/usr/bin/env bash
# Fake `opencode` binary for e2e tests.
# Env:
#   UMBEL_STATE          (set by umbel spawn via tmux env)
#   UMBEL_SESSION_ID     (set by umbel spawn via tmux env)
#   FAKE_OPENCODE_DELAY  optional, ms to sleep before responding (default 0)
#   FAKE_OPENCODE_MODELS_EXTRA  optional, one more id for `models` to list
#   FAKE_OPENCODE_MODELS_EXIT   optional, non-zero makes `models` fail with it
#   FAKE_OPENCODE_MODELS_LOCKED optional file; while it holds a positive count,
#                        `models` fails with "database is locked" and decrements
#                        it, as opencode's SQLite does under a concurrent spawn
#                        (umbel#169)
#   FAKE_OPENCODE_MODELS_CALLS  optional file; every `models` invocation appends
#                        a line, so a test can count the probe's attempts
#   FAKE_OPENCODE_ARGV   optional file; the launch argv is written there, one per line
#   FAKE_OPENCODE_SWALLOW_FIRST_INPUT  optional count of prompts to drop, as the
#                        real TUI drops the first one when its update modal holds
#                        the keyboard (jahala/umbel#116)
#   FAKE_OPENCODE_EXPORT_FILE  optional path `export` reads. The worker writes a
#                        mid-turn export there before it fires stop, and the
#                        final one after FAKE_OPENCODE_FINAL_AFTER_MS (umbel#167).
#   FAKE_OPENCODE_FINAL_AFTER_MS  optional delay before the final export replaces
#                        the mid-turn one; 0 leaves the turn open forever.
#
# This fake stands in for "opencode + umbel's JS plugin" together:
# - Prints a banner so readyMatch can fire.
# - On each prompt: simulates the plugin by touching events/turn-start
#   (session.status {type:"busy"}, which fires when the prompt is submitted),
#   then writing events/session-id and touching events/stop (the same plugin on
#   session.status {type:"idle"}).
# - Never writes a JSONL file — opencode uses SQLite; reads go via
#   `opencode export <sessionID>`, served from FAKE_OPENCODE_EXPORT_FILE when set.

set -euo pipefail

DELAY="${FAKE_OPENCODE_DELAY:-0}"
SESSION_ID="${UMBEL_SESSION_ID:-fake-opencode-session}"
FAKE_SESSION_ID="ses_fake123"

# `opencode export <sessionID>` prints the transcript the worker recorded.
if [[ "${1:-}" == "export" ]]; then
  if [[ -z "${FAKE_OPENCODE_EXPORT_FILE:-}" || ! -f "${FAKE_OPENCODE_EXPORT_FILE}" ]]; then
    echo "fake-opencode: no export recorded" >&2
    exit 1
  fi
  cat "${FAKE_OPENCODE_EXPORT_FILE}"
  exit 0
fi

# `opencode models` prints one provider/model id per line and exits.
if [[ "${1:-}" == "models" ]]; then
  [[ -n "${FAKE_OPENCODE_MODELS_CALLS:-}" ]] && echo called >> "${FAKE_OPENCODE_MODELS_CALLS}"
  if [[ -n "${FAKE_OPENCODE_MODELS_LOCKED:-}" ]]; then
    remaining=$(cat "${FAKE_OPENCODE_MODELS_LOCKED}" 2>/dev/null || echo 0)
    if [[ "${remaining}" -gt 0 ]]; then
      echo $((remaining - 1)) > "${FAKE_OPENCODE_MODELS_LOCKED}"
      echo "Error: Unexpected error" >&2
      echo "database is locked" >&2
      exit 1
    fi
  fi
  if [[ "${FAKE_OPENCODE_MODELS_EXIT:-0}" -ne 0 ]]; then
    echo "fake-opencode: model catalogue unavailable" >&2
    exit "${FAKE_OPENCODE_MODELS_EXIT}"
  fi
  echo "opencode/big-pickle"
  echo "ollama/some-model"
  [[ -n "${FAKE_OPENCODE_MODELS_EXTRA:-}" ]] && echo "${FAKE_OPENCODE_MODELS_EXTRA}"
  exit 0
fi

[[ -n "${FAKE_OPENCODE_ARGV:-}" ]] && printf '%s\n' "$@" > "${FAKE_OPENCODE_ARGV}"

# Print a banner line so readyMatch can fire (real opencode shows "Ask anything...")
echo "Ask anything... (fake-opencode ready)"

events_dir() {
  printf '%s' "${UMBEL_STATE}/sessions/${UMBEL_SESSION_ID}/events"
}

# Mirrors the plugin's forOwnSession (umbel#118): the first event this process
# sends binds its session id, and a later event acts only for that same id.
own_session() {
  local id="$1"
  if [[ -z "${UMBEL_STATE:-}" || -z "${UMBEL_SESSION_ID:-}" ]]; then
    return 1
  fi
  mkdir -p "$(events_dir)"
  local bound=''
  if [[ -f "$(events_dir)/worker-session" ]]; then
    bound=$(cat "$(events_dir)/worker-session")
  fi
  if [[ -z "$bound" ]]; then
    if [[ -n "$id" ]]; then
      printf '%s' "$id" > "$(events_dir)/worker-session"
      printf '%s bind\n' "$(date +%s%N)" >> "$(events_dir)/log"
    fi
    return 0
  fi
  [[ -z "$id" || "$id" == "$bound" ]]
}

fire_turn_start() {
  own_session "${FAKE_SESSION_ID}" || return
  # Simulate the plugin on session.status busy: the submitted prompt started a turn.
  touch "$(events_dir)/turn-start"
  printf '%s turn-start\n' "$(date +%s%N)" >> "$(events_dir)/log"
}

fire_stop() {
  own_session "${FAKE_SESSION_ID}" || return
  # Simulate the plugin: write the opencode session ID and touch the stop file.
  printf '%s' "${FAKE_SESSION_ID}" > "$(events_dir)/session-id"
  touch "$(events_dir)/stop"
  printf '%s stop\n' "$(date +%s%N)" >> "$(events_dir)/log"
}

write_export() {
  [[ -z "${FAKE_OPENCODE_EXPORT_FILE:-}" ]] && return 0
  printf '%s' "$1" > "${FAKE_OPENCODE_EXPORT_FILE}.part"
  mv -f "${FAKE_OPENCODE_EXPORT_FILE}.part" "${FAKE_OPENCODE_EXPORT_FILE}"
}

# The mid-turn shape: the newest assistant message is still calling a tool, so
# the turn has not ended even though the plugin has already fired its stop.
OPEN_EXPORT='{"info":{"id":"ses_fake123"},"messages":[{"info":{"id":"m1","role":"user","time":{"created":1}},"parts":[{"type":"text","text":"a prompt"}]},{"info":{"id":"m2","role":"assistant","finish":"tool-calls","time":{"created":2,"completed":3},"tokens":{"input":10,"output":5}},"parts":[{"type":"step-start"},{"type":"tool","tool":"bash","state":{"status":"running","input":{"command":"sleep 60"}}}]}]}'
FINAL_EXPORT='{"info":{"id":"ses_fake123"},"messages":[{"info":{"id":"m1","role":"user","time":{"created":1}},"parts":[{"type":"text","text":"a prompt"}]},{"info":{"id":"m2","role":"assistant","finish":"stop","time":{"created":2,"completed":4},"modelID":"opencode/big-pickle","tokens":{"input":10,"output":7}},"parts":[{"type":"step-start"},{"type":"text","text":"the final report"},{"type":"step-finish"}]}]}'

process_turn() {
  local prompt="$1"
  fire_turn_start
  write_export "$OPEN_EXPORT"
  if [[ "$DELAY" -gt 0 ]]; then
    sleep "$(echo "scale=3; $DELAY / 1000" | bc)"
  fi
  # The plugin's stop can land before the turn's last message does (umbel#167).
  fire_stop
  local final_after="${FAKE_OPENCODE_FINAL_AFTER_MS:-0}"
  if [[ "$final_after" -gt 0 ]]; then
    sleep "$(echo "scale=3; $final_after / 1000" | bc)"
    write_export "$FINAL_EXPORT"
    touch "$(events_dir)/final-export"
  fi
}

SWALLOW_FIRST_INPUT="${FAKE_OPENCODE_SWALLOW_FIRST_INPUT:-0}"

# Read prompts from stdin in a loop; process a turn per line; exit on /exit or EOF.
while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ "${line:-}" == "/exit" ]] && exit 0
  if [[ "$SWALLOW_FIRST_INPUT" -gt 0 ]]; then
    # The real TUI's update modal takes the keyboard: the paste and its Enter
    # reach no input box, so no turn starts.
    SWALLOW_FIRST_INPUT=$((SWALLOW_FIRST_INPUT - 1))
    continue
  fi
  process_turn "${line:-}"
done
