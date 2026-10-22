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
| 1 | Generic error (session dead, tmux failure, hook timeout, session not created, provider has no unattended mode) |
| 2 | Usage error (bad flags, missing required argument, unknown verb, unsupported option for provider) |
| 122 | `wait` provider-error — a provider error on the pane, then stillness |
| 123 | `wait` idle — pane, events directory and transcript tree all still for `--idle-timeout`, with no model request in flight |
| 124 | `wait` timeout — hard deadline hit |
| 125 | `wait` abandoned — the target worker died before completing its turn |
| 126 | `wait` input — worker is blocked waiting for input (permission prompt / elicitation). Also `spawn` refused because the CLI needs a person to sign in: the same class, blocked. |
| 130 | SIGINT — operation aborted by the user |

The mapping lives in `errorExitCode` and, for `wait` reasons and spawn refusals, `WAIT_EXIT_CODES` and `SPAWN_EXIT_CODES` (`src/faces/cli.ts`). The runner contract in jahala/plotplot reads both tables.

## Lifecycle

A worker's pane is kept after its death. `remain-on-exit` is set on the tmux session, so when the process exits the pane stays, holding its last screen. How the process ended is umbel's own record: the worker is launched through `~/.umbel/hooks/launch.sh`, which writes `~/.umbel/sessions/<name>/events/exit` (`{"exitCode":N}` or `{"signal":"SIGTERM"}`) the moment it ends. `wait` settles `dead` with `exitCode` from that record and the exact final screen from the pane, and writes both to `~/.umbel/sessions/<name>/events/dead`. tmux's own pane status is read only when `events/exit` is absent, such as after a SIGKILL; some tmux builds record none.

`kill` tears down the tmux session but keeps the directory as a tombstone, so `capture`, `logs`, `actions` and `read` still answer for a worker that is gone; `kill --purge` removes it instead. `umbel prune` is the sweep: it removes the directory and the tmux remains of every dead session, and never touches a live one.

---

## Verbs

### spawn

Create a named tmux session running a provider CLI interactively. The session is registered in `~/.umbel/sessions/<name>/meta.json` and appears in tmux as `umbel-<name>`.

```
umbel spawn [--name NAME] [--cwd PATH] [--provider PROVIDER] [--model MODEL] [--allowed-tools TOOLS] [--env KEY[=VALUE]]...
```

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--name NAME` | auto-generated `anon-XXXXXX` | Session name. Must match `^[a-z0-9][a-z0-9-]{0,62}$`. Can also be the first positional argument. |
| `--cwd PATH` | `$PWD` | Working directory for the provider process. Must exist; spawn exits 2 when it does not. |
| `--provider claude\|codex\|gemini\|opencode\|agy` | `claude` | Which CLI to launch. Unknown values → exit 2 with a message listing valid providers. |
| `--model MODEL` | provider default | Free-form model string passed to the provider. Each provider validates its own model names at launch time; umbel does not restrict the values. For `opencode` and `agy`, umbel checks the model against `opencode models` or `agy models` first, and an unlisted model refuses the spawn (exit 2) before a worker exists. |
| `--allowed-tools TOOLS` | unset | Comma-separated tool list forwarded to the provider's equivalent of `--allowedTools`. **Claude only** — passing this for `codex`, `gemini`, or `opencode` is a usage error (exit 2); those providers have no equivalent flag. |
| `--permission-mode MODE` | unset | Claude permission mode (`default`/`acceptEdits`/`bypassPermissions`/`plan`). **Claude only** (usage error otherwise), except `bypassPermissions` which codex also accepts. For the plain "nobody is watching" case prefer `--unattended`, which is provider-neutral; use this flag when you need a *specific* claude posture such as `acceptEdits` or `plan`. An explicit mode wins over `--unattended`. |
| `--unattended` | off | No human is present: suppress every prompt the provider would raise. Maps per-provider — claude `permissions.defaultMode=bypassPermissions`, codex `--dangerously-bypass-approvals-and-sandbox`, gemini `--approval-mode yolo --skip-trust`, opencode `--auto`. A provider with no unattended mode is **refused at spawn** (exit 1) rather than accepted and left to wedge on a prompt later. Safety for unattended work is the surrounding architecture — disposable worktree, publish through a gate, quarantine — never the prompt. |
| `--env KEY=VALUE`, `--env KEY` | — | Give the worker a variable (repeatable). `KEY=VALUE` sets it; a bare `KEY` passes umbel's own `$KEY` by name, which keeps a secret's value off every command line. Wins over what the worker inherits (see [Worker environment](#worker-environment)). Not persisted to `meta.json`. |

**Output:** `spawned: <name>` on stdout.

Exit 0 means the tmux session exists — `spawn` verifies it before returning, so a worker that never started (no tmux server bootable, e.g. detached under `nohup` with an unwritable socket dir) or that died during startup fails immediately with exit 1 rather than succeeding into the void and surfacing later as a `wait` timeout. Session, provider files, and state are cleaned up on that path.

A CLI with no credentials opens on its sign-in screen and waits there for a person. `spawn` refuses such a worker with exit 126, the code of the wait reason `input`, since a person is needed and a retry meets the same screen. It names the screen's line and cleans up. Run the CLI once in a terminal on that machine to sign in, then spawn again. The screens are taken from the installed binaries: claude's first-run setup and login menu, codex's sign-in menu, and gemini's authentication menu. opencode has none.

Before returning, `spawn` waits for the worker to be ready and dismisses the provider's startup dialogs (workspace trust, hook review, update notice) as they appear. Ready means the provider's idle prompt line is on the pane with no dialog pending. For codex the prompt line must also sit below a banner that names its model, since codex paints the prompt line while still loading and can open a dialog after it. For providers that declare a settle window (codex: 1.5 s), the pane must also stay unchanged for that window, because codex keeps redrawing its banner and can raise the trust dialog seconds after the prompt line first appears. A dialog that arrives during the settle is still dismissed. Dialogs are matched on the visible screen, never on scrollback, so a dialog already answered is not answered again. codex is also started with its working directory trusted, so a directory it has never seen (a new worktree) opens without the trust dialog.

An opencode worker is launched with `OPENCODE_DISABLE_AUTOUPDATE=1`. opencode's autoupdate check runs after launch and opens a modal that holds the keyboard until it is answered; a prompt sent while it is up lands on the modal and no turn starts (umbel#116).

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

# OpenCode provider: cloud API model (key passed by name; not subscription-billed)
umbel spawn --name helper --provider opencode --cwd ./worktrees/help --model openrouter/deepseek/deepseek-v4-flash --env OPENROUTER_API_KEY

# An agy (Antigravity CLI) auditor, driven over its stream-json print mode
umbel spawn --name auditor --provider agy --cwd ./worktrees/audit --model gemini-3.1-pro-high --unattended

# Pass env vars to the worker (repeatable): a value, or a name umbel reads from its own environment
umbel spawn --name fixer --provider codex --env HTTPS_PROXY=http://proxy:8080 --env GH_TOKEN

# Anonymous (auto-killed after one turn via umbel -p)
umbel spawn --cwd /tmp/scratch
```

#### Worker environment

A worker inherits only part of the environment umbel runs in: what any CLI needs to run as its user, and the variables its own provider reads. Everything else stays behind, so a key in the caller's shell reaches no worker unless it is passed.

| Worker | Inherits |
|---|---|
| every provider | `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LANGUAGE`, `TZ`, `TMPDIR`, `SSH_AUTH_SOCK`, `LC_*`, `XDG_*`; the proxy variables `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `ALL_PROXY` in either case; the CA bundle variables `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` |
| claude | `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` |
| codex | `OPENAI_*` (umbel sets `CODEX_HOME` itself) |
| gemini | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_*` |
| opencode | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` |

A provider's configuration is named variable by variable. The rest of a vendor's prefix holds the markers a session of that CLI sets for the processes it starts, and a worker launched from inside one must not inherit them.

Pass anything else with `--env` (CLI), `env:` (workflow) or `env` (MCP). Pass a secret by name: `--env OPENROUTER_API_KEY` hands over umbel's own `$OPENROUTER_API_KEY`. Writing the value into the flag (`--env OPENROUTER_API_KEY="$OPENROUTER_API_KEY"`) puts it on umbel's command line, which any local user can read while the command runs. Over MCP and in a workflow the reference is `{"fromEnv": "OPENROUTER_API_KEY"}`.

The environment itself never travels on a command line. umbel loads it into a tmux buffer from stdin; the launch wrapper reads the buffer, deletes it, and starts the worker with exactly that environment.

The keyless opencode models are a free lane, and they are slow: fine for a probe or a smoke check, too slow to sit on the critical path of a gate or an audit. Put gates on a subscription-billed provider and keep the free lane for questions you can afford to wait on.

---

### send

Send a prompt to an existing session. The session must be alive. This dispatches the text and confirms a turn began; it does not wait for the response. Use `umbel wait` after.

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
| `--json` | off | Emit `{"sinceMtime": N}` to stdout: the mtime of `events/stop`, in milliseconds since the epoch, read immediately before the keys were sent. Pass this value to `umbel wait --since N` to make stop-detection race-free when send and wait run in separate processes. **`0` is a valid value, not a failure:** `events/stop` does not exist until a worker's first turn ends, so a send to a fresh worker reports 0, meaning "any stop is newer than this baseline". A conductor that spawns a worker per node and sends one prompt will therefore see 0 every time, correctly. After a turn has ended, the next send reports that stop's mtime, a positive number. |

Multi-line prompts are handled automatically via `tmux load-buffer` + `paste-buffer` (see `src/adapters/tmux.ts`).

`send` returns once the worker has taken the prompt. After the submitting Enter it re-reads the pane. For a provider that shows pending input (codex: `[Pasted Content N chars]` in its input box), while that input is still pending after a short grace, `send` presses Enter again, at most three times. If the input is still pending after that, `send` exits 1 with a message naming the session and the pending input line, and types nothing more. The worker is left alive: inspect it with `umbel capture`, then retry or kill it.

Claude and codex can swallow an Enter that arrives together with a large paste while their TUI is still settling. `send` gives both a 750 ms pause between the text and the submitting Enter.

A provider that can lose the paste declares a turn-start signal. opencode's plugin touches `events/turn-start` when `session.status` turns `busy`; claude's `UserPromptSubmit` hook touches the same file when a submitted prompt begins a turn. `send` snapshots that file before typing and waits up to 10 s for it to advance. If no turn starts, `send` exits 1 naming the session and types nothing more. If the worker dies in that window, `send` exits 1 with the worker's exit status instead. The worker is left alive when it is still running. opencode 1.18.18 lost the first prompt this way because its autoupdate modal opened over the TUI and held the keyboard, so opencode workers are launched with `OPENCODE_DISABLE_AUTOUPDATE=1` (umbel#116). Claude Code 2.1.306 could take the pasted text and the Enter as one gulp during startup and leave the whole prompt in the input box unsent (umbel#121). The signal checked is the one the worker was spawned with, recorded in its `meta.json`, so a worker spawned by an older umbel, which has none, is sent to unchecked as before. One limit remains. A prompt sent while an opencode worker is already mid-turn starts no new turn, so send to an opencode worker only after `wait` returns; claude's `UserPromptSubmit` fires for a prompt queued onto a running turn.

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

A `dead` result carries the evidence: `exitCode`, the status the worker's process exited with, and `paneSnapshot`, its last screen. `exitCode` comes from `events/exit`, written by umbel's launch wrapper as the process ends, with tmux's pane status as the fallback when that record is absent. The screen is read from the pane itself, which `remain-on-exit` keeps after the process is gone, so it is exactly what stood there at the death, not a sample taken shortly before it. A worker killed by a signal exits with no status: `exitCode` is absent and `message` names the signal.

```
umbel wait [--json] [--since N] <name> [--until stop|file|pattern] [--file PATH] [--pattern REGEX] [--timeout DURATION] [--idle-timeout DURATION]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Emit one JSON object to stdout instead of the human-readable stderr output. The exit code is the same as without `--json`. `reason` is always present. `message` comes with `input` (the prompt), `idle` (the still sources) and `provider-error` (the error line); `inputReason` comes with `input` (`permission`, `idle`, `question`, or `sign-in`); `exitCode` and `paneSnapshot` come with `dead`; `paneSnapshot` comes with `timeout`; `runningCommands` and `usage` come with `stop`. When the pane is showing the provider's usage-limit dialog, an `input` result's `message` is that dialog's own line instead of the hook's text; when the pane is showing the provider's own error line (a refused turn), it is that line, and a limit line wins when both show. |
| `--since N` | 0 | Stop-mtime baseline in milliseconds (the `sinceMtime` value from `umbel send --json`). Makes stop-detection race-free when send and wait run in different processes: `wait` only resolves when the stop file's mtime exceeds N. 0 means no stop has been recorded yet, so any stop after the send resolves the wait. |
| `--until stop\|file\|pattern` | `stop` | Condition kind. |
| `--file PATH` | — | Required when `--until=file`. Path to watch for existence. |
| `--pattern REGEX` | — | Required when `--until=pattern`. Regex matched against tmux pane output. |
| `--timeout DURATION` | 30 minutes | Maximum wait time. Format: `5m`, `30s`, `1h`, `500ms`. Exit code 124 on expiry. |
| `--idle-timeout DURATION` | off | Idle net: settle `idle` when nothing the worker touches has moved for this long. Stillness is measured across the pane, the events directory and the transcript tree (for claude, the subagent transcripts too), so a silent pane over a working subagent is not idle. A model request the worker is still waiting on also holds the net: claude writes an `api-request` entry as it sends and the answer as following `assistant` entries, so a slow model with a large context is not read as idle. The hard `--timeout` still bounds a request that never answers. The same poll reports `provider-error` (exit 122) when the pane's last lines match the provider's error pattern and then stay still for a short grace. Off by default (a worker may run a long silent tool call). |

**Wait condition kinds**

- `stop` — waits for the Stop hook to touch `~/.umbel/sessions/<name>/events/stop` with a newer mtime than the pre-send snapshot. This is the only deterministic end-of-turn signal. Only the session umbel launched counts: once the provider's start event has bound its session id in `events/worker-session`, a stop payload carrying another id is ignored, so a CLI the worker runs (it inherits `UMBEL_STATE` and `UMBEL_SESSION_ID`) cannot end the wait (umbel#118).
- `file` — waits for the given path to exist on disk.
- `pattern` — waits for a line in the tmux pane matching the regex.

The default timeout (30 minutes) is enforced even when `--timeout` is not specified. No wait runs forever.

The deadline holds whatever the pane or tmux does. Every tmux call umbel makes is bounded at 5 seconds. A wait that cannot capture the pane within 2 seconds of its deadline still returns `timeout`, with the last pane seen while the worker was alive and a `message` saying tmux did not answer.

The MCP tool `umbel_wait` takes the same fields as the flags (`until`, `file`, `pattern`, `timeout`, `idleTimeout`, `sinceMtime`), through the same translation.

**Outcomes / exit codes**

`wait` reports *why* it ended so a supervisor can act instead of hanging when a worker needs attention:

| Reason | Exit | Meaning |
|--------|------|---------|
| stop | 0 | Turn completed — `umbel read` the result. |
| input | 126 | Worker is **blocked on a prompt** (permission / idle). The prompt text + pane print to stderr — answer with `umbel send`, then `wait` again. A worker on its CLI's sign-in screen, for instance after its credentials expired, is also `input`, with `inputReason: "sign-in"`: only a person signing in on that machine clears it. A worker on its provider's usage-limit dialog is also `input`, and `message` is the dialog's own line, reset time included, as in `You've hit your session limit · resets 4:30pm (Europe/Copenhagen)`. That is not a question: schedule a resume at the reset time instead of retrying now. When the provider refused the turn (an exhausted account, for instance) the CLI fires no stop, only this notification; `message` is then the provider's own error line, as in `API Error: 402 Insufficient Balance (request_id: …)`, and a usage-limit line on the same screen wins over it. Fail or recast the work; the worker is not asking a question. (Every provider has a precise needs-input hook — Claude `Notification`, Codex `PermissionRequest`, Gemini `ToolPermission`, OpenCode `permission.updated`; `--idle-timeout` is the universal backstop.) |
| provider-error | 122 | The pane shows a provider error (codex `unexpected status 404`, claude `API Error`) and then stays still. The matched line is the `message`; the pane prints to stderr. Fail or recast the attempt; waiting longer will not help. |
| idle | 123 | Pane, events directory and transcript tree all still for `--idle-timeout`, and no model request in flight. The `message` names each source and how long it has been still, e.g. `idle 1.6s: pane still 1.6s · events still 1.9s · transcript still 1.8s · subagents none`; a source umbel could not locate reads `unresolved`. Pane prints to stderr. |
| dead | 125 | Worker exited before finishing its turn. `exitCode` is the status it exited with, read from `events/exit` (umbel's launch wrapper), with tmux's pane status as the fallback; `paneSnapshot` is its last screen, captured from the dead pane. |
| timeout | 124 | Hard deadline hit; last pane prints to stderr. |

With `--json` the exit code is the same; the JSON carries the `reason` and `message`.

A `stop` result also carries `runningCommands`, the commands the worker's CLI still has running in its pane at the stop: `[{pid, command}]`, empty when none. A turn can end while a command it started keeps running and writing into the worktree, so a stop is not a promise the worktree is quiet. Only commands the CLI started through a shell count; its own infrastructure (MCP servers it runs, for instance) and the Stop hook itself do not. A command that detaches from the tree, for example under `setsid`, cannot be seen. The listing is read once, at the stop, bounded at 5 seconds. When it cannot be read the field is absent.

A `stop` result also carries `usage`, the token usage of the turn that just ended, when the provider's transcript records it: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `model`. A caller that pays for the turn can record its cost from this result, without parsing the transcript. Every field except `model` is optional, because a provider reports what its format holds. `inputTokens` counts input the provider did not serve from its cache; cache reads and writes stay separate. A turn that took several API answers around tool calls is summed, and a usage record copied onto several transcript entries counts once. The fields are absent when the transcript could not be read, when the turn recorded no usage, or when the provider has no usage extraction (gemini).

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

Show the status table for one session, or every live session. Columns: NAME, STATUS (alive/dead), RUNNING (commands the worker still has running), REPO (the repository's folder name, `—` when none), MODEL, CWD (truncated to 30 chars), CREATED, LAST activity.

```
umbel status [name] [--all] [--repo PATH] [--json]
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Optional. Omit to list live sessions. A named session is answered whether it is alive or a tombstone. |

**Flags**

| Flag | Description |
|------|-------------|
| `--all` | List dead sessions too. Off by default: a machine that has spawned workers all day holds hundreds of tombstones, and a fleet listing means live workers. |
| `--repo PATH` | Keep only the sessions of the repository at `PATH`. Any path inside a repository works, including a linked worktree: spawn records the top-level of the repository's main working tree, so every worktree of one repository matches. Sessions spawned before umbel recorded a repository, and sessions outside git, do not match. |
| `--json` | Emit the entries as one JSON array instead of the table — for shell/CI watchers that can't call MCP. With no `<name>` it lists live sessions unless `--all` is given. |

Each entry adds `needsInput`, `needsInputReason` (`permission` \| `idle` \| `question`), and `pendingTool` to the persisted session fields. `needsInputReason` distinguishes a worker **blocked on a permission prompt** (`permission` — intervene) from one that simply **finished and idled** (`idle` — move on), so a poller never has to scrape the pane. `pendingTool` is best-effort — absent for Claude's main permission prompt, which omits the tool from the hook payload.

`awaitingProviderSince` (claude) is the timestamp of a model request the worker has sent and not yet answered. A slow model leaves the pane, the event log and the transcript still, so this field tells a worker waiting on the provider from one that is wedged. It clears when the answer lands. Absent when nothing is in flight, for a dead worker, and for providers whose transcript cannot say.

`runningCommands` lists `{pid, command}` for each command the worker's CLI still has running in its pane, empty when none. `command` is the executable's name without its arguments, which can carry a token. A worker that started a long command in the background and ended its turn reports it here, so a caller knows the worktree may still be changing. Only commands the CLI started through a shell count; its own infrastructure, such as MCP servers, does not. One `ps` call is made per status, shared by every entry in the listing.

A worker that reaches for a tool not in `--allowedTools` surfaces as `needsInputReason: permission` instead of hanging silently. Avoid it by allowlisting your project's MCP (read-only) tools at spawn — and note that **`Write` does not imply `Edit`** (appending to a file uses `Edit`).

**Examples**

```bash
# Live sessions
umbel status

# Every session, tombstones included
umbel status --all

# Machine-readable, for a fleet watcher
umbel status --json | jq '.[] | select(.needsInputReason == "permission")'

# Only this repository's sessions
umbel status --repo ~/src/umbel

# One session
umbel status reviewer
```

---

When the provider reports subscription rate-limit usage, entries carry a `quota` field (`fiveHourPct`, `sevenDayPct`, `resetsAt`). It is absent whenever no limit pressure is reported, which is the normal case — claude only sends the figures as a window fills. The numbers come from the provider's structured status payload, not from reading the pane. Checking it before dispatch is what lets a caller re-cast work to another provider rather than lose a turn to a limit dialog.

### ls

List live sessions. Equivalent to `umbel status` with no argument. Output is the same columnar table, REPO included. `--all` includes dead sessions (tombstones), which is what a post-mortem reads. `--repo PATH` keeps only the sessions of one repository. `--json` prints the same array `status --json` prints, so a selector reads a field instead of a column.

```
umbel ls [--all] [--repo PATH] [--json]
```

A session's REPO is the folder name of the repository's main working tree, recorded at spawn. Every linked worktree of one repository shows the same value, so a listing tells two conductors' sessions apart. `—` means the worker ran outside git, or was spawned before umbel recorded it.

**Examples**

```bash
umbel ls

# Tombstones too
umbel ls --all

# Only this repository's workers
umbel ls --repo ~/src/umbel

# Names only, for a scripted selector
umbel ls --json | jq -r '.[].name'
```

---

### kill

Kill one or more sessions. Each session's tmux process goes; its state directory stays in `~/.umbel/sessions/` as a tombstone: `events/dead` (how it ended, with the pane read before the session was torn down), the event log and the transcript path, so a post-mortem needs nothing else. `read`, `actions`, `capture` and `status <name>` keep answering from the tombstone. `umbel prune` sweeps tombstones.

```
umbel kill <name>... [--purge] [--dry-run]
umbel kill --prefix PREFIX [--repo PATH] [--purge] [--dry-run]
```

**Names and selectors**

Name the sessions, or select live sessions with `--prefix` and/or `--repo`. The two forms cannot be mixed. A session must match every selector given, so `--prefix pl- --repo ~/src/umbel` kills only that repository's `pl-` sessions. A selector reads the same live listing `umbel ls` prints; with no match it kills nothing and says so. A name kills exactly that session, whether it is alive or already a tombstone.

There is no `--all`: killing every session on a machine is the accident `--prefix` guards against; a fleet cleanup says which fleet.

**Report and exit code**

Each session prints one line: `killed`, `already dead`, `not found`, or `failed` with the reason. One bad name does not stop the others. Exit code 0 means every session was killed or was already dead; 1 means some name was not found or some kill failed; 2 is a usage error (no names and no selector, or names mixed with a selector).

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>...` | One or more session names. |

**Flags**

| Flag | Description |
|------|-------------|
| `--prefix PREFIX` | Kill live sessions whose name starts with `PREFIX`. |
| `--repo PATH` | Keep only the sessions of the repository at `PATH`, using the same resolution as `status --repo`. Combine with `--prefix` to narrow the fleet. |
| `--dry-run` | Print the sessions that would be killed and kill nothing. |
| `--purge` | Remove each selected session's directory too, leaving no record. |

**Examples**

```bash
umbel kill reviewer

# Kill and leave nothing behind
umbel kill reviewer --purge

# See what a fleet cleanup would take, then take it
umbel kill --prefix pl- --dry-run
umbel kill --prefix pl- --repo ~/src/umbel --purge

# Several names in one call
umbel kill a b c
```

---

### prune

Sweep tombstones. Removes the state directory and the tmux remains of every dead session — the pane a dead worker leaves standing, and the directory `kill` keeps. A live session is never touched: liveness is read from the pane, because a session whose worker has exited is still a session. After the sweep, nothing answers for that session: `read`, `actions` and `status <name>` are gone with its directory.

```
umbel prune [--older-than DURATION]
```

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--older-than DURATION` | off | Grace period. Keep any session that died more recently than this, dated from `events/dead` (or, for a worker nobody waited on, from when it was spawned). Format: `5m`, `30s`, `1h`. Without it, every dead session goes. |

Prints one `removed <name>` line per swept session and a `N removed, M kept` summary.

**Examples**

```bash
# Sweep every dead session
umbel prune

# Keep the last day of post-mortems
umbel prune --older-than 24h
```

---

### attach

Attach your terminal to a running session's tmux pane. Hands control directly to tmux; exit with the normal tmux detach key (`Ctrl-b d`). Workers live on their state root's private tmux socket, so a plain `tmux attach` does not see them; `umbel attach` goes to the right socket, and honours `UMBEL_STATE`.

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
umbel read [--json] <name>
```

**Positionals**

| Position | Description |
|----------|-------------|
| `<name>` | Session name. |

**Flags**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Emit one JSON object to stdout instead of the bare text: `{"text": "...", "usage": {...}?}`. `usage` is the same token usage `wait` reports at `stop`, taken from the transcript read the command already performs, and is absent when the provider records none. |

**Notes**

- If the session JSONL has not been discovered yet (too soon after spawn), the command errors with exit code 1.
- A killed (not purged) session still answers: the tombstone keeps the transcript path and the provider's transcript, so this is the call that reads a dead worker's last answer.
- The JSONL reader joins consecutive assistant partial entries and only trusts entries carrying `stop_reason` — partial streams without it are not yet the final response.
- A read taken within 5 seconds of the stop waits for the turn's final message before reading, so `usage` covers the turn that just ended, not the one before it.

**Examples**

```bash
umbel read reviewer
umbel read reviewer > review.md
umbel read --json reviewer | jq '.usage'
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

A dead worker's pane outlives its process, so its last screen reads the same as a live one's. Once the session is gone — killed — the screen recorded in `events/dead` is written instead, and a note on stderr says so; stdout carries only the screen either way.

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
| `--provider claude\|codex\|gemini\|opencode\|agy` | `claude` | Which CLI to launch. Unknown values → exit 2 with a message listing valid providers. |
| `--model MODEL` | provider default | Free-form model string passed to the provider. Each provider validates its own model names at launch time. For `opencode`, a model `opencode models` does not list is refused (exit 2) before a worker exists. |
| `--allowed-tools TOOLS` | unset | Forwarded to the provider's equivalent of `--allowedTools`. |
| `--env KEY=VALUE`, `--env KEY` | — | Give the worker a variable (repeatable), as for [`spawn`](#worker-environment). |
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

Cleanest is **inheritance**: export the vars in the shell (or process) that launches umbel. A claude worker inherits every `ANTHROPIC_*` variable, so no secret appears in any spawn call.

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL='deepseek-v4-pro[1m]'
umbel spawn --provider claude --name ds --cwd ./work
```

Or scope them to one worker. Put the key in umbel's environment for that one command, and the rest in `--env`:

```bash
ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" umbel spawn --provider claude --name ds --cwd ./work \
  --env ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  --env 'ANTHROPIC_MODEL=deepseek-v4-pro[1m]'
```

Never write the key itself into an `--env` value; see [Worker environment](#worker-environment).

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

**Note on OpenCode config:** umbel installs its stop plugin once into opencode's global plugin directory, `$XDG_CONFIG_HOME/opencode/plugin/opencode-stop.ts` (default `~/.config/opencode/plugin/`), where opencode loads it on launch. One copy serves every umbel state root. umbel adds no entry to `opencode.jsonc`; it edits that file only to remove entries an older umbel added (`…/hooks/opencode-stop.ts`). The file is read as JSONC, so comments and trailing commas are fine, and every other byte is preserved, comments included. A file with nothing to remove is not written. An unparsable file refuses the spawn (exit 1) with its path, line and column, and is left untouched.

**Note on OpenCode billing:** OpenCode has no subscription. Models are local (`ollama/…`, free), free-tier (`opencode/big-pickle`, keyless but limited), or API-billed (`anthropic/…`, `openrouter/…` — your key, your quota). For API-billed opencode models, pass the key by name, as in `--env OPENROUTER_API_KEY`; an opencode worker inherits only its `OPENCODE_CONFIG*` variables on its own. umbel does not manage opencode API keys.
