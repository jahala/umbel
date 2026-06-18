#!/usr/bin/env bash
# Fake `gemini` binary for e2e tests.
# Env: UMBEL_SESSION_ID, FAKE_GEMINI_DELAY (ms), FAKE_GEMINI_TRANSCRIPT_DIR, FAKE_GEMINI_HOOK
set -euo pipefail

DELAY="${FAKE_GEMINI_DELAY:-0}"
SESSION_ID="${UMBEL_SESSION_ID:-fake-gemini-session}"

if [[ -n "${FAKE_GEMINI_TRANSCRIPT_DIR:-}" ]]; then
  mkdir -p "${FAKE_GEMINI_TRANSCRIPT_DIR}"
  JSONL_FILE="${FAKE_GEMINI_TRANSCRIPT_DIR}/session-${SESSION_ID}.jsonl"
else
  PROJECT_HASH="$(echo -n "$(pwd)" | sed 's/[^a-zA-Z0-9]/-/g')"
  JSONL_FILE="${HOME}/.gemini/tmp/${PROJECT_HASH}/chats/session-${SESSION_ID}.jsonl"
  mkdir -p "$(dirname "$JSONL_FILE")"
fi

# Write session_metadata as the first line (Gemini JSONL convention)
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '{"type":"session_metadata","sessionId":"%s","projectHash":"fake","startTime":"%s"}\n' \
  "${SESSION_ID}" "${NOW}" > "${JSONL_FILE}"

fire_hook() {
  local prompt="$1"
  local response="$2"
  if [[ -n "${FAKE_GEMINI_HOOK:-}" && -x "${FAKE_GEMINI_HOOK}" ]]; then
    # Mirror Gemini's AfterAgent payload: base fields + prompt/prompt_response/stop_hook_active.
    # stop.sh extracts transcript_path via jq; values are test-internal (no JSON escaping needed).
    local cwd_now ts
    cwd_now="$(pwd)"
    ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    local payload
    payload=$(printf \
      '{"session_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"AfterAgent","timestamp":"%s","prompt":"%s","prompt_response":"%s","stop_hook_active":false}' \
      "${SESSION_ID}" "${JSONL_FILE}" "${cwd_now}" "${ts}" "${prompt}" "${response}")
    printf '%s' "${payload}" | bash "${FAKE_GEMINI_HOOK}"
  fi
}

write_turn() {
  local prompt="$1"
  local now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local response="Response to: ${prompt}"

  if [[ "$DELAY" -gt 0 ]]; then
    sleep "$(echo "scale=3; $DELAY / 1000" | bc)"
  fi

  # User turn
  printf '{"type":"user","id":"u-%s","content":[{"text":%s}]}\n' \
    "$$" \
    "$(echo -n "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    >> "$JSONL_FILE"

  # Gemini turn
  printf '{"type":"gemini","id":"g-%s","content":[{"text":%s}]}\n' \
    "$$" \
    "$(echo -n "$response" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    >> "$JSONL_FILE"

  # Token update (mirrors Gemini's message_update record)
  printf '{"type":"message_update","id":"g-%s","tokens":{"input":5,"output":4}}\n' \
    "$$" >> "$JSONL_FILE"

  fire_hook "${prompt}" "${response}"
}

# Read prompts from stdin in a loop; write a turn per line; exit on /exit or EOF
while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ "${line:-}" == "/exit" ]] && exit 0
  write_turn "${line:-}"
done
