# rctrl — Open Question Findings

Resolution of `docs/architecture-v2.md` §13 open questions. Verified against Anthropic docs and Claude Code GitHub issues, May 2026.

## Q1: Stop hook semantics — **RESOLVED**

Stop fires **only at end-of-turn**, after response generation completes. Not mid-turn, not on tool waits, not on permission prompts.

Source: [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks).

**Implication:** safe as "agent done" signal. No spurious wakes.

## Q2: JSONL write ordering — **RESOLVED with caveat**

JSONL lines stream incrementally during generation. Assistant messages arrive as **multiple partial entries** without `stop_reason` set until response completes. Stop hook may fire before the final line is fully flushed.

Source: [What I Learned Parsing Claude Code's JSONL](https://medium.com/@ywian/what-i-learned-parsing-claude-codes-jsonl-session-logs-268248be0a2c).

**Implication:** `adapters/jsonl.ts` must:
1. Read JSONL after Stop fires.
2. Walk back from the end, joining consecutive assistant entries.
3. Only trust the last entry if it carries `stop_reason`.
4. If not, retry with backoff (50ms × up to 10 retries).

## Q3: `claude -p` permission defaults — **RESOLVED**

`claude -p` defaults to **read-only**: no Bash/Edit without `--allowedTools`. Default mode is `dontAsk` (no interactive prompts). Read-only builtins (`ls`, `cat`, `git status`, etc.) work without approval.

Source: [Configure permissions](https://code.claude.com/docs/en/permissions); [Print Mode & Automation](https://deepwiki.com/zebbern/claude-code-guide/3.2-print-mode-and-automation).

**Implication:** `rctrl -p` mirrors `claude -p` defaults. Pass `--allowedTools` and/or `--dangerously-skip-permissions` through unchanged.

## Q4: `--remote-control` — **ORTHOGONAL TO RCTRL**

`--remote-control` (`--rc`) is **cloud-based device sync**: connect to the same Claude Code session from another device via a session URL/QR. Subscription-billed on Team/Enterprise plans. Requires Claude Code v2.1.51+.

Source: [Remote Control docs](https://code.claude.com/docs/en/remote-control).

**Implication:** not a control API. rctrl and `--remote-control` are complementary, not overlapping. Mention in README; do not integrate in v1.

## Q5: `--worktree` and `--tmux` — **AVAILABLE BUT NOT USED**

Both built-in:
- `--worktree [name]`: creates a git worktree, scopes session to it.
- `--tmux`: wraps session in tmux (or iTerm2 native panes if available).

Source: [Power User Tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips).

**Decision:** **rctrl manages tmux directly** (not via `claude --tmux`). Reasons:
1. The iTerm2 fallback in `claude --tmux` makes behavior environment-dependent.
2. We need predictable session names (`rctrl-<name>`) for `send-keys` / `capture-pane`.
3. Direct control is simpler than working around `claude`'s tmux conventions.

Worktree management remains the user's responsibility (`git worktree add` before `rctrl spawn --cwd ...`). Future: rctrl could wrap `--worktree`. Out of v1 scope.

## Q6: Hook installation via `--settings` — **RESOLVED**

`--settings '<inline-json>'` works. Pass:
```json
{ "hooks": { "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/script" }] }] } }
```

Source: [Hooks guide](https://code.claude.com/docs/en/hooks-guide); [Settings overview](https://code.claude.com/docs/en/settings).

**Implication:** no need to write `.claude/settings.local.json` in the cwd. Cleaner, no collision risk.

## Q7: Multi-line prompts — **RESOLVED**

`tmux send-keys -l` loses newlines. Use `load-buffer` + `paste-buffer`:
```bash
echo "$PROMPT" | tmux load-buffer -b "rctrl-buf" -
tmux paste-buffer -p -d -b "rctrl-buf" -t "session"
tmux send-keys -t "session" Enter
```

`-p` = bracketed paste (handles terminals that interpret characters as commands), `-d` = delete buffer after paste.

Source: [GitHub Issue #43169](https://github.com/anthropics/claude-code/issues/43169).

**Implication:** `adapters/tmux.ts` exposes `sendText(name, text)` that auto-picks `paste-buffer` when `text.includes('\n')`, else `send-keys -l`.

## Q8: `--session-id` & JSONL path — **PARTIALLY RESOLVED**

- In `-p` mode: `--session-id <uuid>` controls JSONL filename. JSONL at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
- In **interactive mode** (which rctrl uses): `--session-id` is API/telemetry only. The CLI generates its own UUID for local persistence.
- CWD encoding: replace non-alphanumeric with `-`. Example: `/Users/you/code` → `-Users-you-code`.

Source: [Sessions docs](https://code.claude.com/docs/en/agent-sdk/sessions); [Issue #44607](https://github.com/anthropics/claude-code/issues/44607).

**Implication:** rctrl cannot pre-determine the interactive JSONL filename. Workaround:
1. Before spawn: snapshot `ls ~/.claude/projects/<encoded-cwd>/*.jsonl` → set A.
2. Spawn claude.
3. Watch the projects dir with chokidar for new `.jsonl` files appearing.
4. The new file (not in set A) is ours. Save path to `meta.json`.

This is implemented in `adapters/jsonl.ts:discoverSessionJsonl(cwd, sinceMs)`.

---

## Updates baked into v2.1 (in this doc + CLAUDE.md)

- JSONL frame merging required (Q2).
- JSONL discovery via dir snapshot diff (Q8).
- Multi-line auto-routing via `sendText` (Q7).
- Hook installation via inline `--settings` (Q6) — already in §6 of architecture-v2.
- rctrl manages tmux directly (Q5).
- `claude -p` default permissions mirrored (Q3).
- `--remote-control` documented as orthogonal (Q4).

---

## Gemini CLI wire format

Researched May 2026. Sources:
- [Hooks reference | Gemini CLI](https://geminicli.com/docs/hooks/reference/)
- [Writing hooks | Gemini CLI](https://geminicli.com/docs/hooks/writing-hooks/)
- [AfterAgent hooks blog post — Google Developers Blog](https://developers.googleblog.com/tailor-gemini-cli-to-your-workflow-with-hooks/)
- [Gemini CLI hooks reference (GitHub)](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)
- [Issue #14715 — Hooks: Transcript Path Support](https://github.com/google-gemini/gemini-cli/issues/14715)
- [Issue #15292 — Switch to JSONL for chat session storage](https://github.com/google-gemini/gemini-cli/issues/15292)
- [PR #23749 — feat(core): migrate chat recording to JSONL streaming](https://github.com/google-gemini/gemini-cli/pull/23749)
- [Session management | Gemini CLI](https://geminicli.com/docs/cli/session-management/)

### settings.json hooks block

Hooks are configured in `~/.gemini/settings.json` (user-global) or `<cwd>/.gemini/settings.json` (project-level). Project settings override user settings. There is no inline `--settings` flag equivalent (unlike Claude's `--settings '<json>'`). rctrl must write the file to disk before launch and clean it up on kill.

```json
{
  "hooks": {
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/stop.sh",
            "name": "rctrl-stop",
            "timeout": 60000
          }
        ]
      }
    ]
  }
}
```

Notes:
- `AfterAgent` currently only supports `"*"` as a matcher (fires on every turn regardless of content).
- `type: "command"` is the shell-command variant. Gemini CLI always pipes the payload on stdin.
- The settings key is `"hooks"` (not `"hooksConfig"` — that is the enable/disable meta object).

### Hook stdin payload (AfterAgent)

All lifecycle events share a common base payload; `AfterAgent` adds three extra fields:

```json
{
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "transcript_path": "/Users/you/.gemini/tmp/abc123def456/chats/session-a1b2c3d4.jsonl",
  "cwd": "/Users/you/project",
  "hook_event_name": "AfterAgent",
  "timestamp": "2026-05-22T10:30:00.000Z",
  "prompt": "Summarize this PR",
  "prompt_response": "This PR refactors the session storage layer...",
  "stop_hook_active": false
}
```

Field descriptions:
- `session_id` — UUID for the running session.
- `transcript_path` — absolute path to the session JSONL file. **Status caveat: this field was stubbed (always empty string) as of Dec 2025 (issue #14715). PR #23749 migrates session storage to JSONL and wires `transcript_path` into hook payloads for new sessions. The field is present but may be an empty string on older builds.** rctrl's stop.sh uses `jq -r '.transcript_path // empty'` which degrades gracefully when empty.
- `cwd` — working directory from which Gemini CLI was launched.
- `hook_event_name` — always `"AfterAgent"` for end-of-turn.
- `timestamp` — ISO 8601 UTC.
- `prompt` — the user's original request text (AfterAgent-specific).
- `prompt_response` — final text generated by the model (AfterAgent-specific).
- `stop_hook_active` — `true` if running inside a retry sequence triggered by a prior hook's `"deny"` decision (AfterAgent-specific).

### Transcript file format

Gemini CLI migrated from monolithic JSON (`session-*.json`) to append-only JSONL (`session-*.jsonl`) in early 2026 (PR #23749). New sessions use JSONL; legacy `.json` files remain readable by the CLI.

**Location:** `~/.gemini/tmp/<project_hash>/chats/session-<uuid>.jsonl`

Each line is a JSON object of one of these types:

```jsonl
{"type":"session_metadata","sessionId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","projectHash":"abc123def456","startTime":"2026-05-22T10:30:00.000Z"}
{"type":"user","id":"msg1","content":[{"text":"Summarize this PR"}]}
{"type":"gemini","id":"msg2","content":[{"text":"This PR refactors the session storage layer..."}]}
{"type":"message_update","id":"msg2","tokens":{"input":42,"output":17}}
```

Record types:
- `session_metadata` — first line only; contains `sessionId`, `projectHash`, `startTime`.
- `user` — user turn; `id` is a stable message ID, `content` is an array of `{text}` objects.
- `gemini` — model turn; same shape as `user`.
- `message_update` — appended after a `gemini` record; carries `tokens` counters and other async updates.

### Differences from Claude

| Aspect | Claude | Gemini |
|---|---|---|
| End-of-turn event name | `Stop` | `AfterAgent` |
| Hook config delivery | `--settings '<inline-json>'` (no file write) | `<cwd>/.gemini/settings.json` must be written to disk |
| Transcript format | JSONL, `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | JSONL (new) or JSON (legacy), `~/.gemini/tmp/<project_hash>/chats/session-<uuid>.jsonl` |
| `transcript_path` in payload | Reliable, present from first Stop | Present but stubbed empty until early 2026; treat defensively |
| `--session-id` flag | Controls JSONL filename in `-p` mode | Not available; session UUID is always auto-generated |
| Non-interactive mode | `claude -p "<prompt>"` | `gemini --prompt "<prompt>"` (or `-p`) |
| AfterAgent-specific payload fields | N/A | `prompt`, `prompt_response`, `stop_hook_active` |
| Global config location | `~/.claude/settings.json` | `~/.gemini/settings.json` |
| Project config location | `.claude/settings.local.json` | `.gemini/settings.json` |

### rctrl integration notes

- The same `stop.sh` from `src/adapters/hooks.ts` works unchanged — it reads `transcript_path` from stdin via jq regardless of which provider's event name triggered it.
- GeminiProvider writes `.gemini/settings.json` at spawn time (project-level, not `~/.gemini/settings.json` to avoid mutating user globals). Operations layer removes it on kill.
- If `transcript_path` comes back empty (older Gemini builds), fall through to the `discoverSessionJsonl` dir-snapshot path as a defensive fallback.
- No `GEMINI_SESSION_ID` environment variable has been confirmed in the public docs; session IDs are assigned internally. rctrl identifies the session via the transcript-path written by stop.sh.

---

## Codex CLI wire format

Researched May 2026. Sources: authoritative Codex source code at `github.com/openai/codex` (Rust crates `codex-rs/hooks`, `codex-rs/protocol`, `codex-rs/rollout`) and `developers.openai.com/codex/hooks`.

### Hook config (`~/.codex/hooks.json` or `<cwd>/.codex/hooks.json`)

Codex loads hook config from either a `hooks.json` file or an inline `[hooks]` table in `config.toml`. Both representations use the same event schema. If both exist in one layer, Codex loads both and warns; prefer one representation per layer.

The `hooks.json` file wraps a `hooks` key whose value is an object keyed by event name. Each value is an array of matcher groups. The `Stop` event ignores `matcher` (all registered handlers fire):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/stop.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

`HookHandlerConfig` supports `type: "command"` (the only type that executes a shell process), `type: "prompt"` (parsed but skipped), and `type: "agent"` (parsed but skipped). `command` is a shell string, `timeout` is in seconds (not milliseconds), and `statusMessage` is an optional display string. The `matcher` field on the group is optional; when absent or null, the group matches unconditionally.

Source: `codex-rs/config/src/hook_config.rs` — `HooksFile`, `HookEventsToml`, `MatcherGroup`, `HookHandlerConfig` structs with their serde annotations.

There is **no `--config-dir` CLI flag** and no `--hooks` flag. To redirect the config root, set `CODEX_HOME` (defaults to `~/.codex`). Hook files are loaded from `$CODEX_HOME/hooks.json` and `<cwd>/.codex/hooks.json`. rctrl writes to `<cwd>/.codex/hooks.json` (project-level) to avoid mutating user globals.

### Hook stdin payload (Stop event)

Every command hook receives a single-line JSON object on stdin. The Stop event payload is authoritative from `codex-rs/hooks/schema/generated/stop.command.input.schema.json`:

```json
{
  "session_id": "0199a213-81c0-7800-8aa1-bbab2a035a53",
  "turn_id": "turn-uuid-string",
  "transcript_path": "/Users/you/.codex/sessions/2026/05/22/rollout-2026-05-22T10-00-00-0199a213-81c0-7800-8aa1-bbab2a035a53.jsonl",
  "cwd": "/Users/you/project",
  "hook_event_name": "Stop",
  "model": "o4-mini",
  "permission_mode": "default",
  "stop_hook_active": false,
  "last_assistant_message": "I have completed the task."
}
```

All nine fields are `required` per the schema. `transcript_path` and `last_assistant_message` are typed as `string | null` (defined as `NullableString` in the schema). In practice, `transcript_path` is null only on `SessionStart`; at `Stop` it is always set — confirmed by `codex-rs/hooks/src/events/stop.rs` where `StopRequest.transcript_path: Option<PathBuf>` is populated from the session's rollout file path.

`stop_hook_active` is `true` if a prior Stop hook already triggered continuation for this turn (prevents infinite loops when a hook re-prompts the agent). `permission_mode` is one of `default | acceptEdits | plan | dontAsk | bypassPermissions`.

The hook script's stdout is parsed as JSON by Codex. Exit 0 with empty stdout is treated as success/continue. rctrl's `stop.sh` writes nothing to stdout and exits 0 — correct behavior.

Source: `codex-rs/hooks/schema/generated/stop.command.input.schema.json` (generated schema), `codex-rs/hooks/src/events/stop.rs` (serialization path).

### Transcript JSONL envelope

Codex persists sessions to JSONL rollout files. Each line is a `RolloutLine` which flattens to:

```
{ "timestamp": "<RFC3339ms>", "type": "<variant>", "payload": { ... } }
```

`RolloutItem` uses `#[serde(tag = "type", content = "payload", rename_all = "snake_case")]`, so the outer `type` field is the snake_case `RolloutItem` variant name. The four persisted variants are:

- `session_meta` — first line of every file (session ID, cwd, CLI version, model provider).
- `response_item` — raw OpenAI Responses API item (the model-visible context).
- `event_msg` — Codex protocol event. Payload is an `EventMsg` with its own nested `type` tag. This is the source of the human-readable assistant response.
- `turn_context` — per-turn config snapshot (model, sandbox, approval policy). Not needed for transcript parsing.

Full JSONL examples (from `codex-rs/app-server/tests/common/rollout.rs` and protocol struct definitions):

```jsonl
{"timestamp":"2026-05-22T10:00:00.000Z","type":"session_meta","payload":{"id":"0199a213-81c0-7800-8aa1-bbab2a035a53","timestamp":"2026-05-22T10:00:00Z","cwd":"/Users/you/project","originator":"codex","cli_version":"0.1.0","model_provider":"openai"}}
{"timestamp":"2026-05-22T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"timestamp":"2026-05-22T10:00:01.100Z","type":"event_msg","payload":{"type":"user_message","message":"hello"}}
{"timestamp":"2026-05-22T10:00:05.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Hello! How can I help you?"}}
{"timestamp":"2026-05-22T10:00:05.100Z","type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}}
```

The `agent_message` event carries `message` as a flat string. `EventMsg::AgentMessage` uses `#[serde(rename_all = "snake_case")]`, giving `"type": "agent_message"`. The turn-complete event is `EventMsg::TurnComplete` but is wire-renamed to `"task_complete"` (via `#[serde(rename = "task_complete", alias = "turn_complete")]`) for backward compat.

**`parseTranscript` algorithm for Codex**: walk backward from the end of the JSONL file; find the last line where `type == "event_msg"` and `payload.type == "agent_message"`; return `payload.message`. No partial-entry retry needed — Codex does not stream partial `event_msg` lines. The Stop hook fires after the turn is fully written.

File path pattern: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`
Filename example: `rollout-2025-05-07T17-24-21-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl`

Source: `codex-rs/protocol/src/protocol.rs` — `RolloutLine`, `RolloutItem`, `EventMsg` structs and serde attributes; `codex-rs/app-server/tests/common/rollout.rs` — real JSONL construction in test fixtures; `codex-rs/rollout/src/recorder.rs` — rollout path derivation.

### Launch flags

Codex has no `--session-id` flag, no `--hooks` flag, and no `--config-dir` flag. Flags used by rctrl:

- `--model, -m <string>` — override model (e.g. `o4-mini`, `gpt-5`)
- `--cd, -C <path>` — set working directory
- `--sandbox, -s <read-only|workspace-write|danger-full-access>` — sandbox policy
- `--dangerously-bypass-hook-trust` — skip hook trust validation (verify whether needed in prod)
- `--ignore-user-config` — skip `config.toml` (test isolation)
- `CODEX_HOME` env var — redirects the entire config/state directory (isolation knob)

Non-interactive mode: `codex exec "prompt"` (progress to stderr, final message to stdout). No `-p` flag equivalent; `codex exec` is the closest analog. The interactive TUI is launched as `codex` (no subcommand) — rctrl spawns it this way.

Source: `developers.openai.com/codex/cli/reference`; `developers.openai.com/codex/config-advanced`.

### Quirks

1. **No `--session-id` equivalent**: The transcript filename UUID is Codex's own internal thread ID, not controllable at launch time. `transcript_path` in the Stop hook payload is the only reliable way to locate the transcript. If `transcript_path` is null at Stop (should not happen; treat defensively), fall back to scanning `$CODEX_HOME/sessions/YYYY/MM/DD/` for the newest `.jsonl` file.

2. **No inline config flag**: Claude supports `--settings '<json>'` to pass hook config without writing files. Codex has no equivalent — rctrl must write `<cwd>/.codex/hooks.json` before launch and remove it on kill.

3. **Hook stdout is parsed as JSON**: Codex reads stdout from hook scripts and interprets it as a `{ "continue": bool, "stopReason": "...", "decision": "block", "reason": "..." }` object. Exit 0 with empty stdout is success/continue. rctrl's `stop.sh` writes nothing to stdout — correct.

4. **`transcript_path` documented as unstable**: The Codex docs state "the transcript format is not a stable interface for hooks and may change over time." rctrl's use (reading `agent_message` events) is low-coupling but warrants a comment in `CodexProvider.parseTranscript`.

5. **No trust dialog**: Codex does not show a workspace-trust prompt on first launch in a new cwd. The `isRealClaudeBin` trust-dialog gate in rctrl has no Codex equivalent.

6. **ASSUMPTION — `--dangerously-bypass-hook-trust` in production**: rctrl installs hooks from `~/.rctrl/hooks/stop.sh`, which is not in `$CODEX_HOME`. Codex may reject untrusted hook paths without this flag. Verify during CodexProvider integration tests before baking into `buildLaunch`.

7. **ASSUMPTION — `turn_id` in fixture payload**: The Stop payload includes `turn_id` as a required field. The fake-codex fixture generates a synthetic UUID per-turn. Real Codex assigns this internally; rctrl's `stop.sh` ignores it (only extracts `transcript_path`).

### Differences from Claude

| Aspect | Claude | Codex |
|---|---|---|
| End-of-turn event name | `Stop` | `Stop` (same) |
| Hook config delivery | `--settings '<inline-json>'` | `<cwd>/.codex/hooks.json` written to disk |
| Transcript location | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl` |
| Transcript format | `{ "type": "human"\|"assistant", "message": {...} }` | `{ "timestamp": "...", "type": "event_msg", "payload": { "type": "agent_message", "message": "..." } }` |
| `--session-id` flag | Controls JSONL filename in `-p` mode | Not available |
| Non-interactive mode | `claude -p "<prompt>"` | `codex exec "<prompt>"` |
| Partial-entry streaming | Yes — Stop may fire before last line flushed | No — JSONL fully written before Stop fires |
| Trust dialog on first launch | Yes (dismissed by rctrl) | No |
