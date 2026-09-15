#!/usr/bin/env bash
# Fake `codex` binary for e2e tests.
# Env vars:
#   UMBEL_SESSION_ID       (passed by umbel at spawn time)
#   FAKE_CODEX_DELAY       optional, ms to sleep before responding (default 0)
#   FAKE_CODEX_JSONL_DIR   optional, write JSONL here instead of $CODEX_HOME/sessions/...
#   FAKE_CODEX_HOOK        optional, exec this (stop.sh) when done
#   FAKE_CODEX_ERROR       optional, print this line to the pane on a prompt, then hang
#                          forever: no turn, no hook (a provider error at its prompt)
#   FAKE_CODEX_ERROR_THEN_CONTINUE optional, 1 = after the error line sleep 1 s and run the turn
#   FAKE_CODEX_SWALLOW_ENTERS optional, N = on a prompt print codex's pasted-input placeholder
#                          and swallow N further Enters (empty stdin lines) before the turn starts
#   FAKE_CODEX_STDIN_LOG   optional, append every stdin line read here (one line per read)
#   FAKE_CODEX_STARTUP     optional, 0154 = render codex 0.154.0's recorded startup with
#                          its timings, trust dialog included, before reading prompts

set -euo pipefail

DELAY="${FAKE_CODEX_DELAY:-0}"
ERROR_LINE="${FAKE_CODEX_ERROR:-}"
ERROR_THEN_CONTINUE="${FAKE_CODEX_ERROR_THEN_CONTINUE:-0}"
SWALLOW_ENTERS="${FAKE_CODEX_SWALLOW_ENTERS:-}"
STDIN_LOG="${FAKE_CODEX_STDIN_LOG:-}"
STARTUP="${FAKE_CODEX_STARTUP:-}"
SESSION_ID="${UMBEL_SESSION_ID:-fake-codex-session}"

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

log_stdin() {
  [[ -n "$STDIN_LOG" ]] && printf '%s\n' "$1" >> "$STDIN_LOG"
  return 0
}

# codex reads its tty raw, so typed input and Enters are never echoed; keeping the
# echo would print a row per swallowed Enter below the placeholder, and would
# shift the trust dialog the startup erases in place.
if [[ -n "$SWALLOW_ENTERS" || -n "$STARTUP" ]]; then
  stty -echo 2>/dev/null || true
fi

# The startup codex 0.154.0 rendered under umbel (test/fixtures/codex-0.154-startup.txt):
# the banner with the model still loading, a second later the full banner with the
# Tip and the usage-limit line, a second after that the trust dialog, which holds
# until an Enter. The idle prompt line is on the pane from the first frame, so a
# readiness check that does not wait for the screen to settle returns too early.
if [[ "$STARTUP" == "0154" ]]; then
  cat <<'EOF'
╭───────────────────────────────────────╮
│ >_ OpenAI Codex (v0.154.0)            │
│                                       │
│ model:     loading   /model to change │
│ directory: loading                    │
╰───────────────────────────────────────╯
› Ask Codex to do anything
  ? for shortcuts
EOF
  sleep 1
  cat <<'EOF'
╭────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.154.0)                         │
│                                                    │
│ model:       gpt-6-astra   /model to change        │
│ directory:   /private/tmp/umbel-codex-probe-HOJKN6 │
│ permissions: YOLO mode                             │
╰────────────────────────────────────────────────────╯
  Tip: New Use /fast to enable our fastest inference with increased plan usage.
• You have 3 usage limit resets available. Run /usage to use one.
› Ask Codex to do anything
EOF
  sleep 1
  cat <<'EOF'
> You are in /private/tmp/umbel-codex-probe-HOJKN6
  Do you trust the contents of this directory? Working with untrusted contents
  comes with higher risk of prompt injection. Trusting the directory allows
  project-local config, hooks, and exec policies to load.
› 1. Yes, continue
  2. No, quit
  Press enter to continue
EOF
  IFS= read -r answer || true
  log_stdin "${answer:-}"
  # Erased in place (cursor up, erase to end): a screen clear would push the dialog
  # into tmux scrollback, where capture-pane still reads it.
  printf '\033[7A\033[J'
fi

# The idle prompt line codex's readyMatch waits for.
echo "› Ask Codex to do anything"

# Read prompts from stdin in a loop; write a turn per line; exit on /exit or EOF.
while IFS= read -r line || [[ -n "${line:-}" ]]; do
  log_stdin "${line:-}"
  [[ "${line:-}" == "/exit" ]] && exit 0
  if [[ -n "$SWALLOW_ENTERS" ]]; then
    # codex holds a paste as a placeholder in the input box until an Enter takes it;
    # once the turn starts the box is redrawn and the placeholder is gone.
    # Redrawn in place (cursor up, erase to end): a screen clear would push the
    # placeholder into tmux scrollback, where capture-pane still reads it.
    echo "› [Pasted Content ${#line} chars]"
    for ((i = 0; i < SWALLOW_ENTERS; i++)); do
      IFS= read -r enter || true
      log_stdin "${enter:-}"
    done
    printf '\033[1A\033[J'
    echo "• Working"
  fi
  if [[ -n "$ERROR_LINE" ]]; then
    echo "$ERROR_LINE"
    if [[ "$ERROR_THEN_CONTINUE" != "1" ]]; then
      while true; do sleep 3600; done
    fi
    sleep 1
  fi
  write_turn "${line:-}"
done
