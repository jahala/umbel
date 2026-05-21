#!/usr/bin/env bash
# Fake `claude` binary for e2e tests.
# Env vars:
#   RCTRL_STATE           (so hook can find session dir)
#   RCTRL_SESSION_ID      (passed by rctrl when launching)
#   FAKE_CLAUDE_DELAY     optional, ms to sleep before responding (default 0)
#   FAKE_CLAUDE_JSONL_DIR optional, write JSONL here instead of ~/.claude/projects/...
#   FAKE_CLAUDE_HOOK      optional, exec this (stop.sh) when done

set -euo pipefail

DELAY="${FAKE_CLAUDE_DELAY:-0}"
SESSION_ID="${RCTRL_SESSION_ID:-fake-session}"

if [[ -n "${FAKE_CLAUDE_JSONL_DIR:-}" ]]; then
  mkdir -p "${FAKE_CLAUDE_JSONL_DIR}"
  JSONL_FILE="${FAKE_CLAUDE_JSONL_DIR}/${SESSION_ID}.jsonl"
else
  ENCODED_CWD="$(echo -n "$(pwd)" | sed 's/[^a-zA-Z0-9]/-/g')"
  JSONL_FILE="${HOME}/.claude/projects/${ENCODED_CWD}/${SESSION_ID}.jsonl"
  mkdir -p "$(dirname "$JSONL_FILE")"
fi

# Touch the JSONL file immediately so discoverSessionJsonl can find it
touch "${JSONL_FILE}"

fire_hook() {
  if [[ -n "${FAKE_CLAUDE_HOOK:-}" && -x "${FAKE_CLAUDE_HOOK}" ]]; then
    bash "${FAKE_CLAUDE_HOOK}"
  fi
}

write_turn() {
  local prompt="$1"
  local now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  # User message line
  printf '{"type":"human","message":{"role":"user","content":[{"type":"text","text":%s}]},"uuid":"u-%s","timestamp":"%s"}\n' \
    "$(echo -n "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$$" "$now" >> "$JSONL_FILE"

  # Sleep if requested
  if [[ "$DELAY" -gt 0 ]]; then
    sleep "$(echo "scale=3; $DELAY / 1000" | bc)"
  fi

  # Partial assistant entry (no stop_reason)
  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Thinking..."}],"stop_reason":null},"uuid":"a1-%s","timestamp":"%s"}\n' \
    "$$" "$now" >> "$JSONL_FILE"

  # Final assistant entry with end_turn
  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stop_reason":"end_turn"},"uuid":"a2-%s","timestamp":"%s"}\n' \
    "$(echo -n "Response to: $prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$$" "$now" >> "$JSONL_FILE"

  fire_hook
}

# Read prompts from stdin in a loop; write a turn per line; exit on /exit or EOF
while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ "${line:-}" == "/exit" ]] && exit 0
  write_turn "${line:-}"
done
