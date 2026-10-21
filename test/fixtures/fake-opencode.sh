#!/usr/bin/env bash
# Fake `opencode` binary for e2e tests.
# Env:
#   UMBEL_STATE          (set by umbel spawn via tmux env)
#   UMBEL_SESSION_ID     (set by umbel spawn via tmux env)
#   FAKE_OPENCODE_DELAY  optional, ms to sleep before responding (default 0)
#   FAKE_OPENCODE_MODELS_EXTRA  optional, one more id for `models` to list
#   FAKE_OPENCODE_MODELS_EXIT   optional, non-zero makes `models` fail with it
#   FAKE_OPENCODE_ARGV   optional file; the launch argv is written there, one per line
#   FAKE_OPENCODE_SWALLOW_FIRST_INPUT  optional count of prompts to drop, as the
#                        real TUI drops the first one when its update modal holds
#                        the keyboard (jahala/umbel#116)
#
# This fake stands in for "opencode + umbel's JS plugin" together:
# - Prints a banner so readyMatch can fire.
# - On each prompt: simulates the plugin by touching events/turn-start
#   (session.status {type:"busy"}, which fires when the prompt is submitted),
#   then writing events/session-id and touching events/stop (the same plugin on
#   session.status {type:"idle"}).
# - Never writes a JSONL file — opencode uses SQLite; reads go via
#   `opencode export <sessionID>`, injected in tests via deps.exec.

set -euo pipefail

DELAY="${FAKE_OPENCODE_DELAY:-0}"
SESSION_ID="${UMBEL_SESSION_ID:-fake-opencode-session}"
FAKE_SESSION_ID="ses_fake123"

# `opencode models` prints one provider/model id per line and exits.
if [[ "${1:-}" == "models" ]]; then
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

fire_turn_start() {
  if [[ -z "${UMBEL_STATE:-}" || -z "${UMBEL_SESSION_ID:-}" ]]; then
    return
  fi
  mkdir -p "$(events_dir)"
  # Simulate the plugin on session.status busy: the submitted prompt started a turn.
  touch "$(events_dir)/turn-start"
  date +%s%N >> "$(events_dir)/log"
}

fire_stop() {
  if [[ -z "${UMBEL_STATE:-}" || -z "${UMBEL_SESSION_ID:-}" ]]; then
    return
  fi
  mkdir -p "$(events_dir)"
  # Simulate the plugin: write the opencode session ID and touch the stop file.
  printf '%s' "${FAKE_SESSION_ID}" > "$(events_dir)/session-id"
  touch "$(events_dir)/stop"
  date +%s%N >> "$(events_dir)/log"
}

process_turn() {
  local prompt="$1"
  fire_turn_start
  if [[ "$DELAY" -gt 0 ]]; then
    sleep "$(echo "scale=3; $DELAY / 1000" | bc)"
  fi
  fire_stop
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
