#!/usr/bin/env bash
# Fake `claude` binary for e2e tests.
# Env vars:
#   UMBEL_STATE           (so hook can find session dir)
#   UMBEL_SESSION_ID      (passed by umbel when launching)
#   FAKE_CLAUDE_DELAY     optional, ms to sleep before responding (default 0)
#   FAKE_CLAUDE_JSONL_DIR optional, write JSONL here instead of ~/.claude/projects/...
#   FAKE_CLAUDE_HOOK      optional, exec this (stop.sh) when done
#   FAKE_CLAUDE_SUBAGENT_MS optional, ms a silent subagent runs: nothing on the pane,
#                         one line every 300 ms to <transcript>/subagents/agent-fake.jsonl
#   FAKE_CLAUDE_HANG_MS   optional, ms to hang mid-turn: nothing on the pane, nothing written
#   FAKE_CLAUDE_PANE_MS   optional, ms to print a progress line to the pane every 500 ms
#   FAKE_CLAUDE_ERROR     optional, print this line to the pane at the start of a turn

set -euo pipefail

ERROR_LINE="${FAKE_CLAUDE_ERROR:-}"

DELAY="${FAKE_CLAUDE_DELAY:-0}"
SUBAGENT_MS="${FAKE_CLAUDE_SUBAGENT_MS:-0}"
HANG_MS="${FAKE_CLAUDE_HANG_MS:-0}"
PANE_MS="${FAKE_CLAUDE_PANE_MS:-0}"
SESSION_ID="${UMBEL_SESSION_ID:-fake-session}"

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
    # Mirror real claude's hook contract: payload with session_id, transcript_path,
    # cwd, hook_event_name on stdin. The stop.sh script extracts transcript_path
    # via jq. Use printf directly (no python dependency) — values here are
    # internal and contain no characters that need JSON escaping.
    local cwd_now
    cwd_now="$(pwd)"
    local payload
    payload=$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"Stop"}' \
      "${SESSION_ID}" "${JSONL_FILE}" "${cwd_now}")
    printf '%s' "${payload}" | bash "${FAKE_CLAUDE_HOOK}"
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

  [[ -n "$ERROR_LINE" ]] && echo "$ERROR_LINE"

  # Real claude keeps a subagent's transcript beside the session's:
  # <dir>/<session>/subagents/agent-<id>.jsonl
  if [[ "$SUBAGENT_MS" -gt 0 ]]; then
    local subagent_dir="${JSONL_FILE%.jsonl}/subagents"
    mkdir -p "$subagent_dir"
    local i
    for ((i = 0; i < SUBAGENT_MS / 300; i++)); do
      printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"subagent step %d"}]}}\n' \
        "$i" >> "${subagent_dir}/agent-fake.jsonl"
      sleep 0.3
    done
  fi

  if [[ "$HANG_MS" -gt 0 ]]; then
    sleep "$(echo "scale=3; $HANG_MS / 1000" | bc)"
  fi

  if [[ "$PANE_MS" -gt 0 ]]; then
    local j
    for ((j = 0; j < PANE_MS / 500; j++)); do
      echo "working ${j}"
      sleep 0.5
    done
  fi

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
