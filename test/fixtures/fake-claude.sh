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
#   FAKE_CLAUDE_EXIT_AT_START optional, exit with this status before printing or
#                         writing anything — a binary that dies during startup
#   FAKE_CLAUDE_DIE_MS    optional, ms into a turn the worker dies: it sleeps that
#                         long, prints "dying now" and leaves — no assistant
#                         entries, no hook
#   FAKE_CLAUDE_EXIT_CODE optional, status the FAKE_CLAUDE_DIE_MS death exits with
#                         (default 1)
#   FAKE_CLAUDE_DIE_ON    optional, substring a prompt must contain for the
#                         FAKE_CLAUDE_DIE_MS death to fire — so a worker can
#                         complete a turn before the turn it dies in. Unset,
#                         every turn dies.
#   FAKE_CLAUDE_LATE_FINAL_MS optional, ms after the Stop hook that the turn's
#                         final message lands, as real claude does: the hook
#                         fires with the previous message (text, then a tool
#                         use) last on disk, and the final message follows as
#                         one entry per content block, each carrying end_turn
#   FAKE_CLAUDE_DIE_SIGNAL optional, signal the FAKE_CLAUDE_DIE_MS death dies by
#                         instead of exiting — stands in for a worker killed by
#                         someone else (tmux records the same wait status)

set -euo pipefail

# Dies before the main UI, like a real binary refused by its own startup (bad
# flag, missing auth). Nothing is printed and nothing is written, so the pane
# holds only what tmux puts there.
if [[ -n "${FAKE_CLAUDE_EXIT_AT_START:-}" ]]; then
  exit "${FAKE_CLAUDE_EXIT_AT_START}"
fi

ERROR_LINE="${FAKE_CLAUDE_ERROR:-}"

DELAY="${FAKE_CLAUDE_DELAY:-0}"
SUBAGENT_MS="${FAKE_CLAUDE_SUBAGENT_MS:-0}"
HANG_MS="${FAKE_CLAUDE_HANG_MS:-0}"
PANE_MS="${FAKE_CLAUDE_PANE_MS:-0}"
DIE_MS="${FAKE_CLAUDE_DIE_MS:-0}"
DIE_SIGNAL="${FAKE_CLAUDE_DIE_SIGNAL:-}"
DIE_ON="${FAKE_CLAUDE_DIE_ON:-}"
EXIT_CODE="${FAKE_CLAUDE_EXIT_CODE:-1}"
LATE_FINAL_MS="${FAKE_CLAUDE_LATE_FINAL_MS:-0}"
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

  # Dies mid-turn: nothing more on the transcript, no hook, so the only record
  # of the death is the pane and the status tmux keeps with it. The last line is
  # printed at the moment of death, after the sleep, so a snapshot taken from
  # the dead pane can be told apart from one sampled earlier while it was alive.
  if [[ "$DIE_MS" -gt 0 && ( -z "$DIE_ON" || "$prompt" == *"$DIE_ON"* ) ]]; then
    sleep "$(echo "scale=3; $DIE_MS / 1000" | bc)"
    echo "dying now"
    if [[ -n "$DIE_SIGNAL" ]]; then
      kill -s "$DIE_SIGNAL" $$
      sleep 10
    fi
    exit "$EXIT_CODE"
  fi

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

  if [[ "$LATE_FINAL_MS" -gt 0 ]]; then
    printf '{"type":"assistant","message":{"id":"m-prev-%s","role":"assistant","content":[{"type":"text","text":"Running the full check."}],"stop_reason":"tool_use"},"timestamp":"%s"}\n' \
      "$$" "$now" >> "$JSONL_FILE"
    printf '{"type":"assistant","message":{"id":"m-prev-%s","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"true"}}],"stop_reason":"tool_use"},"timestamp":"%s"}\n' \
      "$$" "$now" >> "$JSONL_FILE"
    printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"timestamp":"%s"}\n' \
      "$now" >> "$JSONL_FILE"
    fire_hook
    sleep "$(echo "scale=3; $LATE_FINAL_MS / 1000" | bc)"
    printf '{"type":"assistant","message":{"id":"m-final-%s","role":"assistant","content":[{"type":"thinking","thinking":"done"}],"stop_reason":"end_turn"},"timestamp":"%s"}\n' \
      "$$" "$now" >> "$JSONL_FILE"
    printf '{"type":"assistant","message":{"id":"m-final-%s","role":"assistant","content":[{"type":"text","text":%s}],"stop_reason":"end_turn"},"timestamp":"%s"}\n' \
      "$$" "$(echo -n "Response to: $prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$now" >> "$JSONL_FILE"
    return
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

# The main-UI line claude's readyMatch waits for.
echo "? for shortcuts (fake-claude ready)"

# Read prompts from stdin in a loop; write a turn per line; exit on /exit or EOF
while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ "${line:-}" == "/exit" ]] && exit 0
  write_turn "${line:-}"
done
