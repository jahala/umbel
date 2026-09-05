# umbel CLI Reference

`umbel` is a single binary with three entry points: supervisor verbs, the `-p` drop-in mode, and the `mcp` server. All verbs and `-p` flags share zod schemas defined in `src/faces/verbs.ts` — the same schemas drive the MCP tool definitions.

## Usage summary

```
umbel <verb> [flags...]          Supervisor verbs
umbel -p [PROMPT]                Drop-in for claude -p
umbel --help                     Show help
umbel --version                  Show version (0.0.1)
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic error (session dead, tmux failure, JSONL malformed, hook timeout, session not created, provider has no unattended mode) |
| 2 | Usage error (bad flags, missing required argument, unknown verb, unsupported option for provider) |
| 123 | `wait` idle — no pane activity for `--idle-timeout` |
| 124 | `wait` timeout — hard deadline hit |
| 125 | `wait` abandoned — the target worker died before completing its turn |
| 126 | `wait` input — worker is blocked waiting for input (permission prompt / elicitation) |
| 130 | SIGINT — operation aborted by the user |

The mapping lives in `errorExitCode` (`src/faces/cli.ts`).

---

## Verbs

### spawn

Create a named tmux session running a provider CLI interactively. The session is registered in `~/.umbel/sessions/<name>/meta.json` and appears in tmux as `umbel-<name>`.

```
umbel spawn [--name NAME] [--cwd PATH] [--provider PROVIDER] [--model MODEL] [--allowed-tools TOOLS] [--env KEY=VALUE]...
```

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--name NAME` | auto-generated `anon-XXXXXX` | Session name. Must match `^[a-z0-9][a-z0-9-]{0,62}$`. Can also be the first positional argument. |
| `--cwd PATH` | `$PWD` | Working directory for the provider process. Must exist. |
| `--provider claude\|codex\|gemini\|opencode` | `claude` | Which CLI to launch. Unknown values → exit 2 with a message listing valid providers. |
| `--model MODEL` | provider default | Free-form model string passed to the provider. Each provider validates its own model names at launch time; umbel does not restrict the values. |
| `--allowed-tools TOOLS` | unset | Comma-separated tool list forwarded to the provider's equivalent of `--allowedTools`. **Claude only** — passing this for `codex`, `gemini`, or `opencode` is a usage error (exit 2); those providers have no equivalent flag. |
| `--permission-mode MODE` | unset | Claude permission mode (`default`/`acceptEdits`/`bypassPermissions`/`plan`). **Claude only** (usage error otherwise), except `bypassPermissions` which codex also accepts. For the plain "nobody is watching" case prefer `--unattended`, which is provider-neutral; use this flag when you need a *specific* claude posture such as `acceptEdits` or `plan`. An explicit mode wins over `--unattended`. |
| `--unattended` | off | No human is present: suppress every prompt the provider would raise. Maps per-provider — claude `permissions.defaultMode=bypassPermissions`, codex `--dangerously-bypass-approvals-and-sandbox`, gemini `--approval-mode yolo --skip-trust`, opencode `--auto`. A provider with no unattended mode is **refused at spawn** (exit 1) rather than accepted and left to wedge on a prompt later. Safety for unattended work is the surrounding architecture — disposable worktree, publish through a gate, quarantine — never the prompt. |
| `--env KEY=VALUE` | — | Set an environment variable for the worker (repeatable). Merged over the inherited environment. Use for per-worker proxies, API keys, or custom config dirs. Not persisted to `meta.json`. |

**Output:** `spawned: <name>` on stdout.

Exit 0 means the tmux session exists — `spawn` verifies it before returning, so a worker that never started (no tmux server bootable, e.g. detached under `nohup` with an unwritable socket dir) or that died during startup fails immediately with exit 1 rather than succeeding into the void and surfacing later as a `wait` timeout. Session, provider files, and state are cleaned up on that path.

`--provider` is only valid on `spawn` and `-p`. For `send`, `wait`, `read`, `kill`, `status`, `ls`, `attach`, `capture`, and `logs`, the provider is looked up automatically from `meta.json` — no `--provider` flag is accepted.

**Examples**

```bash
# Named session, specific model
umbel spawn --name reviewer --cwd ./worktrees/review --model sonnet

# Codex provider
umbel spawn --name fixer --provider codex --cwd ./worktrees/fix --model o4-mini

# Gemini provider
umbel spawn --name analyst --provider gemini --cwd ./worktrees/analysis

# OpenCode provider — free keyless model
umbel spawn --name helper --provider opencode --cwd ./worktrees/help --model opencode/big-pickle

# OpenCode provider — local Ollama model (no API key needed)
umbel spawn --name helper --provider opencode --cwd ./worktrees/help --model ollama/qwen2.5-coder

# OpenCode provider — cloud API model (key passed via --env; not subscription-billed)
umbel spawn --name helper --provider opencode --cwd ./worktrees/help --model openrouter/deepseek/deepseek-v4-flash --env OPENROUTER_API_KEY=sk-...

# Pass env vars to the worker (repeatable) — e.g. a proxy or a custom-endpoint key
umbel spawn --name fixer --provider codex --env HTTPS_PROXY=http://proxy:8080 --env FOO=bar

# Anonymous (auto-killed after one turn via umbel -p)
umbel spawn --cwd /tmp/scratch
```

The keyless opencode models are a free lane, and they are slow: fine for a probe or a smoke check, too slow to sit on the critical path of a gate or an audit. Put gates on a subscription-billed provider and keep the free lane for questions you can afford to wait on.

---

### send

Send a prompt to an existing session. The session must be alive. This only dispatches the text; it does not wait for a response. Use `umbel wait` after.

```
umbel send [--json] <name> <prompt>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name (first positional). |
| `<prompt>` | Prompt text (second positional). Also accepted as `--prompt`. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Emit `{"sinceMtime": N}` to stdout — the mtime snapshot of `events/stop` taken immediately before the keys were sent. Pass this value to `umbel wait --since N` to make stop-detection race-free when send and wait run in separate processes. **`0` is a valid value, not a failure:** `events/stop` does not exist until a worker's first turn ends, so the first send to a fresh worker always reports 0, meaning "no turn has ended yet — any stop counts". A conductor that spawns a worker per node and sends one prompt will therefore see 0 every time, correctly. |

Multi-line prompts are handled automatically via `tmux load-buffer` + `paste-buffer` (see `src/adapters/tmux.ts`).

**Examples**

```bash
umbel send reviewer "Review the diff in review.md and list issues."

# Capture sinceMtime for race-free wait
SINCE=$(umbel send --json reviewer "Fix the bug" | jq -r .sinceMtime)
umbel wait --since "$SINCE" reviewer

# Multi-line via shell heredoc
umbel send fixer "$(cat <<'EOF'
Apply the fixes listed in fixes.md.
Run the tests when done.
EOF
)"
```

---

### wait

Block until a session reaches a condition. Default: wait for the Stop hook to fire (end of turn). Returns exit code 124 on timeout, or 125 if the worker's session dies before the condition is met (e.g. the CLI crashed or exited non-zero).

A `dead` result carries `paneSnapshot`: the last view of the pane from while the worker was still alive. A dying session takes its pane with it, so without this a crashed worker leaves nothing at all to read — which is exactly what makes a mid-run death expensive to diagnose. The snapshot is refreshed periodically during the wait, so it is at most a couple of seconds behind the moment of death.

```
umbel wait [--json] [--since N] <name> [--until stop|file|pattern] [--file PATH] [--pattern REGEX] [--timeout DURATION]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Emit `{"reason": "...", "message": "...?"}` to stdout and **exit 0 regardless of reason**. The JSON is the signal; non-zero exit codes are only emitted in non-JSON mode. `message` is included when `reason` is `input`. |
| `--since N` | 0 | Stop-mtime baseline (nanosecond timestamp from `umbel send --json`). Makes the stop-detection race-free when send and wait run in different processes: `wait` only resolves when the stop file's mtime exceeds N. |
| `--until stop\|file\|pattern` | `stop` | Condition kind. |
| `--file PATH` | — | Required when `--until=file`. Path to watch for existence. |
| `--pattern REGEX` | — | Required when `--until=pattern`. Regex matched against tmux pane output. |
| `--timeout DURATION` | 30 minutes | Maximum wait time. Format: `5m`, `30s`, `1h`, `500ms`. Exit code 124 on expiry. |
| `--idle-timeout DURATION` | off | Idle net: settle `idle` if the tmux pane shows no change for this long. Off by default (a worker may run a long silent tool call). |

**Wait condition kinds**

- `stop` — waits for the Stop hook to touch `~/.umbel/sessions/<name>/events/stop` with a newer mtime than the pre-send snapshot. This is the only deterministic end-of-turn signal.
- `file` — waits for the given path to exist on disk.
- `pattern` — waits for a line in the tmux pane matching the regex.

The default timeout (30 minutes) is enforced even when `--timeout` is not specified. No wait runs forever.

**Outcomes / exit codes**

`wait` reports *why* it ended so a supervisor can act instead of hanging when a worker needs attention:

| Reason | Exit (non-JSON) | Meaning |
|--------|-----------------|---------|
| stop | 0 | Turn completed — `umbel read` the result. |
| input | 126 | Worker is **blocked on a prompt** (permission / idle). The prompt text + pane print to stderr — answer with `umbel send`, then `wait` again. (Every provider has a precise needs-input hook — Claude `Notification`, Codex `PermissionRequest`, Gemini `ToolPermission`, OpenCode `permission.updated`; `--idle-timeout` is the universal backstop.) |
| idle | 123 | No pane activity for `--idle-timeout`. Pane prints to stderr. |
| dead | 125 | Worker exited before finishing its turn. |
| timeout | 124 | Hard deadline hit; last pane prints to stderr. |

With `--json`, exit code is **always 0** — the `reason` field in the JSON object is the signal.

**Examples**

```bash
# Wait for turn completion (most common)
umbel wait reviewer

# Wait up to 10 minutes
umbel wait reviewer --timeout 10m

# Wait for the agent to produce a file
umbel wait reviewer --until file --file ./worktrees/review/review.md

# Wait for a pattern in pane output
umbel wait reviewer --until pattern --pattern "All tests passed"
```

---

### status

Show the status table for one or all sessions. Columns: NAME, STATUS (alive/dead), MODEL, CWD (truncated to 30 chars), CREATED, LAST activity.

```
umbel status [name] [--json]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Optional. Omit to show all sessions. |

**Flags**

| Flag | Description |
|------|-------------|
| `--json` | Emit the entries as one JSON array instead of the table — for shell/CI watchers that can't call MCP. With no `<name>` it lists every session. |

Each entry adds `needsInput`, `needsInputReason` (`permission` \| `idle` \| `question`), and `pendingTool` to the persisted session fields. `needsInputReason` distinguishes a worker **blocked on a permission prompt** (`permission` — intervene) from one that simply **finished and idled** (`idle` — move on), so a poller never has to scrape the pane. `pendingTool` is best-effort — absent for Claude's main permission prompt, which omits the tool from the hook payload.

A worker that reaches for a tool not in `--allowedTools` surfaces as `needsInputReason: permission` instead of hanging silently. Avoid it by allowlisting your project's MCP (read-only) tools at spawn — and note that **`Write` does not imply `Edit`** (appending to a file uses `Edit`).

**Examples**

```bash
# All sessions
umbel status

# Machine-readable, for a fleet watcher
umbel status --json | jq '.[] | select(.needsInputReason == "permission")'

# One session
umbel status reviewer
```

---

When the provider reports subscription rate-limit usage, entries carry a `quota` field (`fiveHourPct`, `sevenDayPct`, `resetsAt`). It is absent whenever no limit pressure is reported, which is the normal case — claude only sends the figures as a window fills. The numbers come from the provider's structured status payload, not from reading the pane. Checking it before dispatch is what lets a caller re-cast work to another provider rather than lose a turn to a limit dialog.

### ls

List all active sessions. Equivalent to `umbel status` with no argument. Output is the same columnar table.

```
umbel ls
```

**Examples**

```bash
umbel ls
```

---

### kill

Kill a session and (by default) remove its state directory from `~/.umbel/sessions/`.

```
umbel kill <name> [--keep-state]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--keep-state` | false | Kill the tmux session but leave `~/.umbel/sessions/<name>/` on disk. Useful for post-mortem inspection. |

**Examples**

```bash
umbel kill reviewer

# Kill but preserve logs and meta
umbel kill reviewer --keep-state
```

---

### attach

Attach your terminal to a running session's tmux pane. Hands control directly to tmux; exit with the normal tmux detach key (`Ctrl-b d`).

```
umbel attach <name>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Examples**

```bash
umbel attach reviewer
```

---

### read

Write the last assistant message from the session's JSONL log to stdout. Reads `session.jsonl` at the path stored in `meta.json`. Does not interact with the tmux pane.

```
umbel read <name>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Notes**

- If the session JSONL has not been discovered yet (too soon after spawn), the command errors with exit code 1.
- The JSONL reader joins consecutive assistant partial entries and only trusts entries carrying `stop_reason` — partial streams without it are not yet the final response.

**Examples**

```bash
umbel read reviewer
umbel read reviewer > review.md
```

---

### actions

Write a structured digest of what a worker DID this session — tools used (with counts), files read/edited/written, bash commands, errors, and the final message — to stdout. Reads the transcript via the same resolution chain as `read`. Often the right shape for "what happened?" when you don't need the verbatim response.

```
umbel actions [--json] <name>
```

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Emit the raw `ActionManifest` as a single JSON object on stdout (`toolsUsed`, `filesRead/Edited/Written`, `bashCommands`, `errors`, `finalMessage`, `turnCount`) — for code callers like the pleach conductor. Without it, a human/LLM-readable text digest. |

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Examples**

```bash
umbel actions fixer
```

---

### diff

Write a unified text diff between two turns of a session to stdout. Default: the latest turn vs the one before it. Indices are zero-based; negative indices count from the end (`-1` = latest). Useful in review→fix loops to see only what changed since the previous turn.

```
umbel diff <name> [--from N] [--to N]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--from N` | second-to-last turn | Base turn index (negative counts from end). |
| `--to N` | last turn | Target turn index (negative counts from end). |

**Examples**

```bash
umbel diff reviewer                # latest vs previous
umbel diff reviewer --from 0 --to 2
```

---

### capture

Write the last N lines of the tmux pane to stdout. Uses `tmux capture-pane`. For human watching only; do not parse this output for agent responses (use `umbel read` instead).

```
umbel capture <name> [--lines N]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--lines N` | 100 | Number of pane lines to capture. |

**Examples**

```bash
umbel capture reviewer
umbel capture reviewer --lines 50
```

---

### logs

Print the session event log (`~/.umbel/sessions/<name>/events/log`). Each line is a nanosecond timestamp appended when the Stop hook fires.

```
umbel logs <name> [--follow]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--follow` / `-f` | false | Poll for new entries and stream them. Interrupted by SIGINT (exit 130). |

**Examples**

```bash
umbel logs reviewer
umbel logs reviewer --follow
```

---

### run

Execute a workflow YAML file. Spawns the workers declared in `workers:`, executes steps in dependency order (parallel where `needs:` permits), captures outputs, and tears down workers on exit.

```
umbel run <file>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<file>` | Path to workflow YAML file. |

**Output:** `workflow completed: runId=<id>` on success. On failure, the failing step name and reason are written to stderr and exit code 1 is returned.

Workflow run state is persisted at `~/.umbel/workflows/<run-id>/`.

**Examples**

```bash
umbel run review-then-fix.yaml
PR=42 umbel run pr-pipeline.yaml
```

---

### mcp

Start an MCP server on stdio. Exposes all supervisor verbs as MCP tools. Tool input schemas are generated from the same zod definitions in `src/faces/verbs.ts` (single source of truth).

```
umbel mcp
```

Intended to be launched by an MCP host (e.g., Claude Code itself) as a subprocess. Not for interactive use.

**Examples**

```bash
# Typical invocation from an MCP host config
umbel mcp
```

---

### -p / --print (drop-in mode)

Run a single-turn prompt through the interactive provider CLI, wait for completion, and write the response to stdout. Drop-in replacement for `claude -p` that routes through the subscription-billed interactive TUI.

```
umbel -p [PROMPT] [--name NAME] [--resume NAME] [--cwd PATH] [--provider PROVIDER] \
         [--model MODEL] [--allowed-tools TOOLS] [--output-format text|json] [--timeout DURATION]
```

If `PROMPT` is omitted and stdin is not a TTY, the prompt is read from stdin.

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--name NAME` | auto | Name the session. Session survives after the turn (not auto-killed). |
| `--resume NAME` | — | Attach to an existing named session. Sends the prompt and waits; does not kill on exit. |
| `--cwd PATH` | `$PWD` | Working directory. |
| `--provider claude\|codex\|gemini\|opencode` | `claude` | Which CLI to launch. Unknown values → exit 2 with a message listing valid providers. |
| `--model MODEL` | provider default | Free-form model string passed to the provider. Each provider validates its own model names at launch time. |
| `--allowed-tools TOOLS` | unset | Forwarded to the provider's equivalent of `--allowedTools`. |
| `--env KEY=VALUE` | — | Set an environment variable for the worker (repeatable). Merged over the inherited environment. |
| `--output-format text\|json` | `text` | `json` emits `{"text": "...", "sessionName": "..."}`. |
| `--timeout DURATION` | unset (30m default from wait layer) | Maximum wait time. Exit 124 on expiry. |

**Flow (src/faces/p.ts)**

1. Parse argv; read prompt from arg or stdin.
2. Resolve target session: `--resume` must exist; `--name` creates-or-reuses; else spawn anonymous.
3. Snapshot `events/stop` mtime.
4. Send prompt via tmux.
5. Watch `events/stop` for mtime advance.
6. Read last assistant message from JSONL.
7. Write to stdout in requested format.
8. If anonymous: kill + clean up. Named/resumed: leave alive.

**Examples**

```bash
# Basic drop-in
umbel -p "Summarise the changes in the last 5 commits."

# From stdin
git diff HEAD~1 | umbel -p "What broke?"

# Persistent named session, JSON output
umbel -p --name assistant --output-format json "Hello"

# Resume an existing session
umbel -p --resume assistant "Continue from where we left off."

# With tool access
umbel -p --allowed-tools "Read,Bash" "Run the test suite and report failures."
```

---

## Custom model endpoints (Claude provider)

The `claude` provider can target any Anthropic-compatible API — DeepSeek, OpenRouter, a local proxy — by giving the worker its endpoint env. Same Claude Code binary (same hooks, transcript, tools), different model behind it. **Billed per-token by that endpoint, not your Claude subscription.**

Cleanest is **inheritance**: export the vars in the shell (or process) that launches umbel and they reach the worker automatically — no secret in any spawn call.

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL='deepseek-v4-pro[1m]'
umbel spawn --provider claude --name ds --cwd ./work
```

Or set them per-worker with `--env` (CLI) / `env:` (workflow):

```bash
umbel spawn --provider claude --name ds --cwd ./work \
  --env ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  --env ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" \
  --env 'ANTHROPIC_MODEL=deepseek-v4-pro[1m]'
```

- Use **`ANTHROPIC_AUTH_TOKEN`**, not `ANTHROPIC_API_KEY`. umbel drops an inherited `ANTHROPIC_API_KEY` when a custom `AUTH_TOKEN` is set — it would otherwise shadow the endpoint and wedge the worker on Claude Code's "Detected a custom API key… use this key?" prompt.
- Set **`ANTHROPIC_SMALL_FAST_MODEL`** (and/or `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`) to an endpoint-valid model, or Claude Code's background/subagent calls 404 against a model the endpoint lacks.
- Over MCP or in a workflow (no shell to expand `$VARS`), pass a secret **by reference** instead of inlining it: `"ANTHROPIC_AUTH_TOKEN": {"fromEnv": "DEEPSEEK_API_KEY"}` — umbel resolves it from its own env, so the literal never lands in the caller's transcript.
- Quote model strings with brackets (`'…[1m]'`) so the shell does not glob them.
- `umbel status` reports each worker's effective `baseUrl` — confirm routing without a `printenv` round-trip.
- Per-worker: a DeepSeek worker and a subscription Claude worker coexist in one pool.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `UMBEL_STATE` | Override the default state directory (`~/.umbel/`). All session metadata, hook event files, and workflow run state are stored here. Useful in CI or for isolated test environments. Also determines the tmux socket, so two state roots get two independent sets of workers. |
| `UMBEL_TMUX_SOCKET` | Override the tmux socket name, which is otherwise derived from the state root. Set it to the same value in two places to deliberately share one set of workers between them. |
| `UMBEL_CLAUDE_BIN` | Override the `claude` binary path. Used by the test suite to inject `test/fixtures/fake-claude.sh`. Not intended for production use. |
| `UMBEL_CODEX_BIN` | Override the `codex` binary path. Same contract as `UMBEL_CLAUDE_BIN` — inject `test/fixtures/fake-codex.sh` in tests, or point at a non-PATH install. |
| `UMBEL_GEMINI_BIN` | Override the `gemini` binary path. Same contract as `UMBEL_CLAUDE_BIN`. |
| `UMBEL_OPENCODE_BIN` | Override the `opencode` binary path. Same contract as `UMBEL_CLAUDE_BIN`. |

**Note on OpenCode billing:** OpenCode has no subscription. Models are local (`ollama/…`, free), free-tier (`opencode/big-pickle`, keyless but limited), or API-billed (`anthropic/…`, `openrouter/…` — your key, your quota). For API-billed opencode models, pass keys via `--env KEY=VAL` or ensure they are in the inherited env. umbel does not manage opencode API keys.
