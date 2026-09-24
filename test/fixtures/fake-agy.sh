#!/usr/bin/env bash
# Fake `agy` binary for e2e tests: speaks the stream-json print mode of the
# Antigravity CLI 1.2.10 (recordings in test/fixtures/agy/). It prints `init` at
# startup, then reads one NDJSON message per stdin line and answers each with a
# turn: the user_input step, a run_command tool step, the agent's text, and one
# `result`. It exits 0 at end of input, as agy does.
# Env vars:
#   FAKE_AGY_STDIN_LOG   optional, append every stdin line read here
#   FAKE_AGY_ARGS_LOG    optional, write argv here, one argument per line
#   FAKE_AGY_SIGN_IN     optional, 1 = print agy's sign-in screen on stderr and wait,
#                        as agy does with no credentials
#   FAKE_AGY_ERROR       optional, 1 = end each turn with status ERROR

set -uo pipefail

CID=fake-agy-conversation

# `agy models` prints one `<id>\t<label>` line per model, after a progress line
# on stderr.
if [[ "${1:-}" == "models" ]]; then
  echo "Fetching available models..." >&2
  printf 'fake-agy-flash\tFake Agy Flash\nfake-agy-pro\tFake Agy Pro\n'
  exit 0
fi

if [[ -n "${FAKE_AGY_ARGS_LOG:-}" ]]; then
  printf '%s\n' "$@" > "$FAKE_AGY_ARGS_LOG"
fi

if [[ "${FAKE_AGY_SIGN_IN:-}" == "1" ]]; then
  cat "$(dirname "$0")/sign-in/agy-1.2.10-sign-in.txt" >&2
  while true; do sleep 3600; done
fi

step() {
  jq -cn --arg cid "$CID" --argjson i "$1" --arg state "$2" --arg type "$3" --argjson extra "$4" \
    '{event:"step_update",step_update:({conversation_id:$cid,step_index:$i,state:$state,step_type:$type} + $extra)}'
}

jq -cn --arg cid "$CID" --arg cwd "$(pwd)" \
  '{event:"init",conversation_id:$cid,init:{cwd:$cwd,tools:["run_command","view_file"],permission_mode:"request-review"}}'

i=0
turns=0
while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ -n "${FAKE_AGY_STDIN_LOG:-}" ]] && printf '%s\n' "$line" >> "$FAKE_AGY_STDIN_LOG"
  if ! content=$(printf '%s' "$line" | jq -er 'select(.event == "user") | .message.content' 2>/dev/null); then
    echo "warning: ignoring unsupported stream input message" >&2
    continue
  fi
  turns=$((turns + 1))
  step "$i" DONE user_input '{}'
  i=$((i + 1))
  tool=$(jq -cn --arg out "$(pwd -P)" '{tool_name:"run_command",tool_info:{name:"run_command",parameters:{CommandLine:"pwd"},output:$out}}')
  step "$i" ACTIVE tool "$tool"
  step "$i" DONE tool "$tool"
  i=$((i + 1))
  reply="fake agy reply: $content"
  step "$i" DONE agent_response "$(jq -cn --arg t "$reply" '{text_delta:$t}')"
  i=$((i + 1))
  if [[ "${FAKE_AGY_ERROR:-}" == "1" ]]; then
    jq -cn --arg cid "$CID" --argjson n "$turns" \
      '{event:"result",result:{conversation_id:$cid,status:"ERROR",response:"",error:"fake agy failure",num_turns:$n}}'
  else
    jq -cn --arg cid "$CID" --arg r "$reply"$'\n' --argjson n "$turns" \
      '{event:"result",result:{conversation_id:$cid,status:"SUCCESS",response:$r,num_turns:$n,usage:{input_tokens:10,output_tokens:5,thinking_tokens:0,cache_read_tokens:0,total_tokens:15}}}'
  fi
done
exit 0
