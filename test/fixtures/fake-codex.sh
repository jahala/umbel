#!/usr/bin/env bash
# Fake `codex` binary for e2e tests.
# Env vars:
#   RCTRL_SESSION_ID       (passed by rctrl at spawn time)
#   FAKE_CODEX_DELAY       optional, ms to sleep before responding (default 0)
#   FAKE_CODEX_JSONL_DIR   optional, write JSONL here instead of $CODEX_HOME/sessions/...
#   FAKE_CODEX_HOOK        optional, exec this (stop.sh) when done

set -euo pipefail

DELAY="${FAKE_CODEX_DELAY:-0}"
SESSION_ID="${RCTRL_SESSION_ID:-fake-codex-session}"

if [[ -n "${FAKE_CODEX_JSONL_DIR:-}" ]]; then
  mkdir -p "${FAKE_CODEX_JSONL_DIR}"
  JSONL_FILE="${FAKE_CODEX_JSONL_DIR}/${SESSION_ID}.jsonl"
else
  CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
  DATE_PATH="$(date -u +"%Y/%m/%d")"
  TS_PREFIX="$(date -u +"%Y-%m-%dT%H-%M-%S")"
  mkdir -p "${CODEX_HOME}/sessions/${DATE_PATH}"
  JSONL_FILE="${CODEX_HOME}/sessions/${DATE_PATH}/rollout-${TS_PREFIX}-${SESSION_ID}.jsonl"
fi

# session_meta: first line of every Codex rollout file (RolloutLine convention).
NOW="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","timestamp":"%s","cwd":"%s","originator":"fake-codex","cli_version":"0.0.0-test","model_provider":"openai"}}\n' \
  "${NOW}" "${SESSION_ID}" "${NOW}" "$(pwd)" > "${JSONL_FILE}"

fire_hook() {
  if [[ -n "${FAKE_CODEX_HOOK:-}" && -x "${FAKE_CODEX_HOOK}" ]]; then
    # Mirror Codex's Stop hook payload (stop.command.input.schema.json).
    # stop.sh extracts transcript_path via jq. Values are test-internal;
    # no characters needing JSON escaping appear in paths or session IDs.
    # ASSUMPTION: turn_id is required — synthesised as a random UUID here.
    local cwd_now turn_id payload
    cwd_now="$(pwd)"
    turn_id="$(dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n' | sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\)/\1-\2-\3-\4-\5/')"
    payload=$(printf \
      '{"session_id":"%s","turn_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"Stop","model":"o4-mini","permission_mode":"default","stop_hook_active":false,"last_assistant_message":null}' \
      "${SESSION_ID}" "${turn_id}" "${JSONL_FILE}" "${cwd_now}")
    printf '%s' "${payload}" | bash "${FAKE_CODEX_HOOK}"
  fi
}

write_turn() {
  local prompt="$1"
  local now response
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  response="Response to: ${prompt}"
  [[ "$DELAY" -gt 0 ]] && sleep "$(echo "scale=3; $DELAY / 1000" | bc)"

  # response_item: model-visible user message (OpenAI Responses API envelope).
  printf '{"timestamp":"%s","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":%s}]}}\n' \
    "${now}" "$(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    >> "${JSONL_FILE}"

  # event_msg/user_message: human-readable copy of the user turn.
  printf '{"timestamp":"%s","type":"event_msg","payload":{"type":"user_message","message":%s}}\n' \
    "${now}" "$(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    >> "${JSONL_FILE}"

  # event_msg/agent_message: the assistant response (what parseTranscript reads).
  printf '{"timestamp":"%s","type":"event_msg","payload":{"type":"agent_message","message":%s}}\n' \
    "${now}" "$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    >> "${JSONL_FILE}"

  # event_msg/task_complete: wire name for EventMsg::TurnComplete.
  printf '{"timestamp":"%s","type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":4}}}\n' \
    "${now}" >> "${JSONL_FILE}"

  fire_hook
}

# Read prompts from stdin in a loop; write a turn per line; exit on /exit or EOF.
while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ "${line:-}" == "/exit" ]] && exit 0
  write_turn "${line:-}"
done
