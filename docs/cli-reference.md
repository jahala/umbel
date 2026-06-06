# rctrl CLI Reference

`rctrl` is a single binary with three entry points: supervisor verbs, the `-p` drop-in mode, and the `mcp` server. All verbs and `-p` flags share zod schemas defined in `src/faces/verbs.ts` — the same schemas drive the MCP tool definitions.

## Usage summary

```
rctrl <verb> [flags...]          Supervisor verbs
rctrl -p [PROMPT]                Drop-in for claude -p
rctrl --help                     Show help
rctrl --version                  Show version (0.0.1)
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic error (session dead, tmux failure, JSONL malformed, hook timeout) |
| 2 | Usage error (bad flags, missing required argument, unknown verb) |
| 124 | Wait timeout elapsed |
| 125 | `wait` abandoned — the target worker died before completing its turn |
| 130 | SIGINT — operation aborted by the user |

The mapping lives in `errorExitCode` (`src/faces/cli.ts`).

---

## Verbs

### spawn

Create a named tmux session running a provider CLI interactively. The session is registered in `~/.rctrl/sessions/<name>/meta.json` and appears in tmux as `rctrl-<name>`.

```
rctrl spawn [--name NAME] [--cwd PATH] [--provider PROVIDER] [--model MODEL] [--allowed-tools TOOLS] [--env KEY=VALUE]...
```

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--name NAME` | auto-generated `anon-XXXXXX` | Session name. Must match `^[a-z0-9][a-z0-9-]{0,62}$`. Can also be the first positional argument. |
| `--cwd PATH` | `$PWD` | Working directory for the provider process. Must exist. |
| `--provider claude\|codex\|gemini\|opencode` | `claude` | Which CLI to launch. Unknown values → exit 2 with a message listing valid providers. |
| `--model MODEL` | provider default | Free-form model string passed to the provider. Each provider validates its own model names at launch time; rctrl does not restrict the values. |
| `--allowed-tools TOOLS` | unset | Comma-separated tool list forwarded to the provider's equivalent of `--allowedTools`. |
| `--env KEY=VALUE` | — | Set an environment variable for the worker (repeatable). Merged over the inherited environment. Use for per-worker proxies, API keys, or custom config dirs. Not persisted to `meta.json`. |

**Output:** `spawned: <name>` on stdout.

`--provider` is only valid on `spawn` and `-p`. For `send`, `wait`, `read`, `kill`, `status`, `ls`, `attach`, `capture`, and `logs`, the provider is looked up automatically from `meta.json` — no `--provider` flag is accepted.

**Examples**

```bash
# Named session, specific model
rctrl spawn --name reviewer --cwd ./worktrees/review --model sonnet

# Codex provider
rctrl spawn --name fixer --provider codex --cwd ./worktrees/fix --model o4-mini

# Gemini provider
rctrl spawn --name analyst --provider gemini --cwd ./worktrees/analysis

# OpenCode provider — free keyless model
rctrl spawn --name helper --provider opencode --cwd ./worktrees/help --model opencode/big-pickle

# OpenCode provider — local Ollama model (no API key needed)
rctrl spawn --name helper --provider opencode --cwd ./worktrees/help --model ollama/qwen2.5-coder

# OpenCode provider — cloud API model (key passed via --env; not subscription-billed)
rctrl spawn --name helper --provider opencode --cwd ./worktrees/help --model openrouter/deepseek/deepseek-v4-flash --env OPENROUTER_API_KEY=sk-...

# Pass env vars to the worker (repeatable) — e.g. a proxy or a custom-endpoint key
rctrl spawn --name fixer --provider codex --env HTTPS_PROXY=http://proxy:8080 --env FOO=bar

# Anonymous (auto-killed after one turn via rctrl -p)
rctrl spawn --cwd /tmp/scratch
```

---

### send

Send a prompt to an existing session. The session must be alive. This only dispatches the text; it does not wait for a response. Use `rctrl wait` after.

```
rctrl send <name> <prompt>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name (first positional). |
| `<prompt>` | Prompt text (second positional). Also accepted as `--prompt`. |

Multi-line prompts are handled automatically via `tmux load-buffer` + `paste-buffer` (see `src/adapters/tmux.ts`).

**Examples**

```bash
rctrl send reviewer "Review the diff in review.md and list issues."

# Multi-line via shell heredoc
rctrl send fixer "$(cat <<'EOF'
Apply the fixes listed in fixes.md.
Run the tests when done.
EOF
)"
```

---

### wait

Block until a session reaches a condition. Default: wait for the Stop hook to fire (end of turn). Returns exit code 124 on timeout, or 125 if the worker's session dies before the condition is met (e.g. the CLI crashed or exited non-zero).

```
rctrl wait <name> [--until stop|file|pattern] [--file PATH] [--pattern REGEX] [--timeout DURATION]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--until stop\|file\|pattern` | `stop` | Condition kind. |
| `--file PATH` | — | Required when `--until=file`. Path to watch for existence. |
| `--pattern REGEX` | — | Required when `--until=pattern`. Regex matched against tmux pane output. |
| `--timeout DURATION` | 30 minutes | Maximum wait time. Format: `5m`, `30s`, `1h`, `500ms`. Exit code 124 on expiry. |
| `--idle-timeout DURATION` | off | Idle net: settle `idle` if the tmux pane shows no change for this long. Off by default (a worker may run a long silent tool call). |

**Wait condition kinds**

- `stop` — waits for the Stop hook to touch `~/.rctrl/sessions/<name>/events/stop` with a newer mtime than the pre-send snapshot. This is the only deterministic end-of-turn signal.
- `file` — waits for the given path to exist on disk.
- `pattern` — waits for a line in the tmux pane matching the regex.

The default timeout (30 minutes) is enforced even when `--timeout` is not specified. No wait runs forever.

**Outcomes / exit codes**

`wait` reports *why* it ended so a supervisor can act instead of hanging when a worker needs attention:

| Reason | Exit | Meaning |
|--------|------|---------|
| stop | 0 | Turn completed — `rctrl read` the result. |
| input | 126 | Worker is **blocked on a prompt** (permission / idle). The prompt text + pane print to stderr — answer with `rctrl send`, then `wait` again. (Claude detects this precisely via its Notification hook; other providers surface it via `--idle-timeout`.) |
| idle | 126 | No pane activity for `--idle-timeout`. Pane prints to stderr. |
| dead | 125 | Worker exited before finishing its turn. |
| timeout | 124 | Hard deadline hit; last pane prints to stderr. |

**Examples**

```bash
# Wait for turn completion (most common)
rctrl wait reviewer

# Wait up to 10 minutes
rctrl wait reviewer --timeout 10m

# Wait for the agent to produce a file
rctrl wait reviewer --until file --file ./worktrees/review/review.md

# Wait for a pattern in pane output
rctrl wait reviewer --until pattern --pattern "All tests passed"
```

---

### status

Show the status table for one or all sessions. Columns: NAME, STATUS (alive/dead), MODEL, CWD (truncated to 30 chars), CREATED, LAST activity.

```
rctrl status [name]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Optional. Omit to show all sessions. |

**Examples**

```bash
# All sessions
rctrl status

# One session
rctrl status reviewer
```

---

### ls

List all active sessions. Equivalent to `rctrl status` with no argument. Output is the same columnar table.

```
rctrl ls
```

**Examples**

```bash
rctrl ls
```

---

### kill

Kill a session and (by default) remove its state directory from `~/.rctrl/sessions/`.

```
rctrl kill <name> [--keep-state]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--keep-state` | false | Kill the tmux session but leave `~/.rctrl/sessions/<name>/` on disk. Useful for post-mortem inspection. |

**Examples**

```bash
rctrl kill reviewer

# Kill but preserve logs and meta
rctrl kill reviewer --keep-state
```

---

### attach

Attach your terminal to a running session's tmux pane. Hands control directly to tmux; exit with the normal tmux detach key (`Ctrl-b d`).

```
rctrl attach <name>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Examples**

```bash
rctrl attach reviewer
```

---

### read

Write the last assistant message from the session's JSONL log to stdout. Reads `session.jsonl` at the path stored in `meta.json`. Does not interact with the tmux pane.

```
rctrl read <name>
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
rctrl read reviewer
rctrl read reviewer > review.md
```

---

### actions

Write a structured digest of what a worker DID this session — tools used (with counts), files read/edited/written, bash commands, errors, and the final message — to stdout. Reads the transcript via the same resolution chain as `read`. Often the right shape for "what happened?" when you don't need the verbatim response.

```
rctrl actions <name>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Examples**

```bash
rctrl actions fixer
```

---

### diff

Write a unified text diff between two turns of a session to stdout. Default: the latest turn vs the one before it. Indices are zero-based; negative indices count from the end (`-1` = latest). Useful in review→fix loops to see only what changed since the previous turn.

```
rctrl diff <name> [--from N] [--to N]
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
rctrl diff reviewer                # latest vs previous
rctrl diff reviewer --from 0 --to 2
```

---

### capture

Write the last N lines of the tmux pane to stdout. Uses `tmux capture-pane`. For human watching only; do not parse this output for agent responses (use `rctrl read` instead).

```
rctrl capture <name> [--lines N]
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
rctrl capture reviewer
rctrl capture reviewer --lines 50
```

---

### logs

Print the session event log (`~/.rctrl/sessions/<name>/events/log`). Each line is a nanosecond timestamp appended when the Stop hook fires.

```
rctrl logs <name> [--follow]
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
rctrl logs reviewer
rctrl logs reviewer --follow
```

---

### run

Execute a workflow YAML file. Spawns the workers declared in `workers:`, executes steps in dependency order (parallel where `needs:` permits), captures outputs, and tears down workers on exit.

```
rctrl run <file>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<file>` | Path to workflow YAML file. |

**Output:** `workflow completed: runId=<id>` on success. On failure, the failing step name and reason are written to stderr and exit code 1 is returned.

Workflow run state is persisted at `~/.rctrl/workflows/<run-id>/`.

**Examples**

```bash
rctrl run review-then-fix.yaml
PR=42 rctrl run pr-pipeline.yaml
```

---

### mcp

Start an MCP server on stdio. Exposes all supervisor verbs as MCP tools. Tool input schemas are generated from the same zod definitions in `src/faces/verbs.ts` (single source of truth).

```
rctrl mcp
```

Intended to be launched by an MCP host (e.g., Claude Code itself) as a subprocess. Not for interactive use.

**Examples**

```bash
# Typical invocation from an MCP host config
rctrl mcp
```

---

### -p / --print (drop-in mode)

Run a single-turn prompt through the interactive provider CLI, wait for completion, and write the response to stdout. Drop-in replacement for `claude -p` that routes through the subscription-billed interactive TUI.

```
rctrl -p [PROMPT] [--name NAME] [--resume NAME] [--cwd PATH] [--provider PROVIDER] \
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
rctrl -p "Summarise the changes in the last 5 commits."

# From stdin
git diff HEAD~1 | rctrl -p "What broke?"

# Persistent named session, JSON output
rctrl -p --name assistant --output-format json "Hello"

# Resume an existing session
rctrl -p --resume assistant "Continue from where we left off."

# With tool access
rctrl -p --allowed-tools "Read,Bash" "Run the test suite and report failures."
```

---

## Custom model endpoints (Claude provider)

The `claude` provider can target any Anthropic-compatible API — DeepSeek, OpenRouter, a local proxy — by giving the worker its endpoint env. Same Claude Code binary (same hooks, transcript, tools), different model behind it. **Billed per-token by that endpoint, not your Claude subscription.**

Cleanest is **inheritance**: export the vars in the shell (or process) that launches rctrl and they reach the worker automatically — no secret in any spawn call.

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL='deepseek-v4-pro[1m]'
rctrl spawn --provider claude --name ds --cwd ./work
```

Or set them per-worker with `--env` (CLI) / `env:` (workflow):

```bash
rctrl spawn --provider claude --name ds --cwd ./work \
  --env ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  --env ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" \
  --env 'ANTHROPIC_MODEL=deepseek-v4-pro[1m]'
```

- Use **`ANTHROPIC_AUTH_TOKEN`**, not `ANTHROPIC_API_KEY`. rctrl drops an inherited `ANTHROPIC_API_KEY` when a custom `AUTH_TOKEN` is set — it would otherwise shadow the endpoint and wedge the worker on Claude Code's "Detected a custom API key… use this key?" prompt.
- Set **`ANTHROPIC_SMALL_FAST_MODEL`** (and/or `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`) to an endpoint-valid model, or Claude Code's background/subagent calls 404 against a model the endpoint lacks.
- Over MCP or in a workflow (no shell to expand `$VARS`), pass a secret **by reference** instead of inlining it: `"ANTHROPIC_AUTH_TOKEN": {"fromEnv": "DEEPSEEK_API_KEY"}` — rctrl resolves it from its own env, so the literal never lands in the caller's transcript.
- Quote model strings with brackets (`'…[1m]'`) so the shell does not glob them.
- `rctrl status` reports each worker's effective `baseUrl` — confirm routing without a `printenv` round-trip.
- Per-worker: a DeepSeek worker and a subscription Claude worker coexist in one pool.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `RCTRL_STATE` | Override the default state directory (`~/.rctrl/`). All session metadata, hook event files, and workflow run state are stored here. Useful in CI or for isolated test environments. |
| `RCTRL_CLAUDE_BIN` | Override the `claude` binary path. Used by the test suite to inject `test/fixtures/fake-claude.sh`. Not intended for production use. |
| `RCTRL_CODEX_BIN` | Override the `codex` binary path. Same contract as `RCTRL_CLAUDE_BIN` — inject `test/fixtures/fake-codex.sh` in tests, or point at a non-PATH install. |
| `RCTRL_GEMINI_BIN` | Override the `gemini` binary path. Same contract as `RCTRL_CLAUDE_BIN`. |
| `RCTRL_OPENCODE_BIN` | Override the `opencode` binary path. Same contract as `RCTRL_CLAUDE_BIN`. |

**Note on OpenCode billing:** OpenCode has no subscription. Models are local (`ollama/…`, free), free-tier (`opencode/big-pickle`, keyless but limited), or API-billed (`anthropic/…`, `openrouter/…` — your key, your quota). For API-billed opencode models, pass keys via `--env KEY=VAL` or ensure they are in the inherited env. rctrl does not manage opencode API keys.
