#!/usr/bin/env bash
# Fake `opencode` binary for e2e tests.
# Env:
#   RCTRL_STATE          (set by rctrl spawn via tmux env)
#   RCTRL_SESSION_ID     (set by rctrl spawn via tmux env)
#   FAKE_OPENCODE_DELAY  optional, ms to sleep before responding (default 0)
#
# This fake stands in for "opencode + rctrl's JS plugin" together:
# - Prints a banner so readyMatch can fire.
# - On each prompt: simulates the plugin by writing events/session-id and
#   touching events/stop (what the real opencode plugin would do on
#   session.status {type:"idle"}).
# - Never writes a JSONL file — opencode uses SQLite; reads go via
#   `opencode export <sessionID>`, injected in tests via deps.exec.

set -euo pipefail

DELAY="${FAKE_OPENCODE_DELAY:-0}"
SESSION_ID="${RCTRL_SESSION_ID:-fake-opencode-session}"
FAKE_SESSION_ID="ses_fake123"

# Print a banner line so readyMatch can fire (real opencode shows "Ask anything...")
echo "Ask anything... (fake-opencode ready)"

fire_stop() {
  if [[ -z "${RCTRL_STATE:-}" || -z "${RCTRL_SESSION_ID:-}" ]]; then
    return
  fi
  local events_dir="${RCTRL_STATE}/sessions/${RCTRL_SESSION_ID}/events"
  mkdir -p "${events_dir}"
  # Simulate the plugin: write the opencode session ID and touch the stop file.
  printf '%s' "${FAKE_SESSION_ID}" > "${events_dir}/session-id"
  touch "${events_dir}/stop"
  date +%s%N >> "${events_dir}/log"
}

process_turn() {
  local prompt="$1"
  if [[ "$DELAY" -gt 0 ]]; then
    sleep "$(echo "scale=3; $DELAY / 1000" | bc)"
  fi
  fire_stop
}

# Read prompts from stdin in a loop; process a turn per line; exit on /exit or EOF.
while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ "${line:-}" == "/exit" ]] && exit 0
  process_turn "${line:-}"
done
