# rctrl — Architecture v2

> Remote-control interactive `claude` (and similar agent CLIs) over tmux.
> One binary, three faces: headless drop-in, supervisor, workflow runner.
>
> **Supersedes** `architecture.md` (kept for reference / decision history).

## 0. What changed from v1

| v1 | v2 | Why |
|---|---|---|
| Session pool with claim/release/flock | No pool. Anonymous = spawn-and-die. Named = explicit lifecycle. | Pool was ~200 LOC optimizing a 3–5s startup. Defer until measured. |
| `text` / `json` / `stream-json` output | `text` / `json` only | `stream-json` needs JSONL chunk-emission machinery. Niche. Defer. |
| Stop + UserPromptSubmit hooks | Stop only | If our input isn't received, Stop also doesn't fire. Redundant. |
| `Result<T, RctrlError>` everywhere | Typed thrown errors, caught at face boundary | Idiomatic TS without dragging in `effect`/`fp-ts`. |
| `Worker` + `Session` types | Just `Session` (with optional name) | A worker is a named session. One concept. |
| `$XDG_STATE_HOME/rctrl` | `~/.rctrl/` (overridable via `$RCTRL_STATE`) | More discoverable on macOS. |
| Custom session index | `tmux ls` is the index | Don't duplicate state tmux already keeps. |
| Stop hook persists payload + symlinks | Stop hook touches a file, appends a timestamp log | All we need is "did it fire since last send?" via mtime. |

Net: ~500 LOC cut, ~1000 LOC v1 target, story tightens.

## 1. What it is

`rctrl` is a single TypeScript binary (Bun-compiled) that drives interactive agent CLIs running inside tmux sessions.

It exists because Anthropic priced `claude -p` at API rates while leaving the interactive TUI on subscription billing. `rctrl` provides a programmatic surface (CLI, MCP, YAML) over the *interactive* binary so subscription users can automate their own work without paying API rates.

Three faces, one engine:

| Face | Command | For |
|---|---|---|
| Headless drop-in | `rctrl -p [PROMPT]` | swap-in for `claude -p` in scripts |
| Supervisor | `rctrl spawn / send / wait / status / kill` (also MCP) | an agent orchestrating other agents |
| Workflow runner | `rctrl run workflow.yaml` | repeatable declarative pipelines |

## 2. Principles

- **No daemon.** tmux is the daemon. The filesystem is the state store. Every `rctrl` invocation is short-lived.
- **Side effects at the edge** (S.U.P.E.R.). Pure core, thin I/O adapters, side-effecty faces.
- **Files as IPC.** Hook events are file touches; `fs.watch` is the event bus.
- **Stop hook as keystone.** Completion detection uses Claude's native `Stop` hook — not terminal scraping.
- **JSONL as truth.** Agent output is read from `~/.claude/projects/.../session.jsonl`. `capture-pane` is for watching, not parsing.
- **One language, one binary.** TypeScript + Bun. Zero runtime deps for users.
- **Throw at the boundary.** Typed errors thrown from adapters/operations, caught and translated at faces.

## 3. Layered architecture

```
┌──────────────────────────────────────────────────────┐
│  faces/      cli  |  mcp  |  workflow  |  -p         │  ← argv dispatch, MCP server, YAML executor
├──────────────────────────────────────────────────────┤
│  operations/  spawn  send  wait  status  kill        │  ← composition: orchestrate adapters
├──────────────────────────────────────────────────────┤
│  adapters/   tmux  fs-state  jsonl  hooks  fs-watch  │  ← thin I/O wrappers, one boundary each
├──────────────────────────────────────────────────────┤
│  core/       types  wait-predicates  workflow-graph  │  ← pure, no I/O, fully unit-testable
└──────────────────────────────────────────────────────┘
```

**Rule:** lower layers know nothing about upper layers. Adapters are injected. Nothing reaches across.

## 4. Domain model

```ts
// core/types.ts

type SessionName = string & { __brand: 'SessionName' };

interface Session {
  name: SessionName;          // also the tmux session suffix: "rctrl-<name>"
  cwd: string;                // working directory claude runs in
  model?: 'opus' | 'sonnet' | 'haiku';
  anonymous: boolean;         // true → auto-kill after one turn
  createdAt: number;
  jsonlPath: string;          // ~/.claude/projects/<encoded-cwd>/<session>.jsonl
}

// State derived at read time, not stored:
//   - alive?    →  tmux has-session -t rctrl-<name>
//   - busy?     →  was Stop event mtime advanced since last send?
//   - last activity → events/log tail
```

```ts
// core/wait.ts

type WaitCondition =
  | { kind: 'stop'; session: SessionName; sinceMtime: number }
  | { kind: 'file'; path: string }
  | { kind: 'pattern'; session: SessionName; regex: string }
  | { kind: 'timeout'; ms: number }
  | { kind: 'all'; conditions: WaitCondition[] }
  | { kind: 'any'; conditions: WaitCondition[] };

interface CompiledWait {
  evaluate(): boolean;
  wakeSources: WakeSource[];  // file paths to watch + timer
}

function compile(cond: WaitCondition): CompiledWait;  // pure
```

```ts
// core/workflow.ts

interface WorkflowSpec {
  workers: Record<SessionName, WorkerSpec>;
  steps: WorkflowStep[];
}

interface WorkflowStep {
  run: SessionName;
  prompt: string;                              // supports {{var}} substitution
  wait?: WaitCondition;
  outputs?: Record<string, OutputSpec>;        // capture JSONL last msg, file contents, etc.
  needs?: SessionName[];
}
```

## 5. State on disk (source of truth)

```
~/.rctrl/                              # or $RCTRL_STATE
├─ sessions/
│  └─ <name>/
│     ├─ meta.json                     # Session struct (atomic write)
│     └─ events/
│        ├─ stop                       # touch()'d on each Stop hook fire
│        └─ log                        # append-only: "<ns> stop\n"
├─ hooks/
│  └─ stop.sh                          # one global copy, all sessions reference
└─ workflows/
   └─ <run-id>/
      ├─ workflow.yaml
      ├─ status.json
      └─ outputs/<step>/...
```

**Naming.** A session named `foo` lives in tmux as `rctrl-foo`. Anonymous sessions get auto-names like `anon-a1b2c3` and are killed on exit.

**Atomicity.** `meta.json` is written via temp-then-rename. No locks needed — we never have concurrent writers to the same session (one rctrl process owns the session for the duration of a turn).

**Why filesystem.**
- Any `rctrl` invocation can answer "what's the state of X?" by reading files + querying tmux.
- Crash-safe: tmux and state files survive `rctrl` crashes.
- Inspectable: `ls`, `cat`, `tmux ls` debug everything.
- Watchable: `fs.watch` (via chokidar) is the event bus.

## 6. The Stop hook (the keystone)

Installed once at `~/.rctrl/hooks/stop.sh`. Each session's `.claude/settings.local.json` references it.

```bash
#!/usr/bin/env bash
set -euo pipefail
state="${RCTRL_STATE:?}/sessions/${RCTRL_SESSION_ID:?}"
mkdir -p "$state/events"
touch "$state/events/stop"
date +%s%N >> "$state/events/log"
```

Three lines. The only deterministic signal that a turn ended.

**Wait semantics (mtime snapshot):**
```
1. Caller snapshots stat("events/stop").mtime (0 if file absent)
2. Caller sends prompt via tmux
3. Caller watches "events/stop" with chokidar
4. When new mtime > snapshot → done
5. Read last assistant message from JSONL
```

This handles:
- Stop firing before we started watching (snapshot detects it on first read)
- Multiple concurrent waiters (each snapshots independently)
- Process restart (mtime survives)

## 7. Wait predicates (composable algebra)

```yaml
wait: { stop: $session, timeout: 10m }       # implicit `all`
wait:
  any:
    - { stop: $session }
    - { file: ./out.md }
    - { timeout: 5m }
```

Compiles to a pure `(evaluate, wakeSources)` pair. The operation layer watches all wake sources, re-evaluates on each event, returns when the predicate is true (or aborts on timeout).

Default for all waits if unspecified: `{ any: [{ stop: session }, { timeout: 30m }] }`. Never wait forever.

## 8. Session lifecycle (no pool)

```
                         spawn
   nothing ───────────────────────► booting
                                       │
                                       │ hook system reachable, jsonl path resolved
                                       ▼
                                     ready ◄─────┐
                                       │         │
                                  send-keys      │ Stop fires
                                       │         │
                                       ▼         │
                                     busy ───────┘
                                       │
                                  kill / tmux dies
                                       ▼
                                     dead
```

**Anonymous (one-shot, default for `rctrl -p`):**
```
spawn(anonymous=true) → ready
send(prompt) → busy
wait({stop}) → ready
read JSONL → text
kill + rm session dir
```

**Named (explicit, for supervisor / multi-turn):**
```
rctrl spawn --name foo            # ready
rctrl send foo "step 1"           # busy
rctrl wait foo                    # ready
rctrl send foo "step 2"           # busy
...
rctrl kill foo                    # dead, rm session dir
```

**Resume:**
```
rctrl -p --resume foo "prompt"    # if 'foo' exists, attach + send + wait + read
                                  # does NOT kill on exit
```

**Listing:**
```
rctrl ls                          # tmux ls | grep '^rctrl-' | enrich with meta.json
```

## 9. The faces

### 9a. `rctrl -p` (headless drop-in for `claude -p`)

```
rctrl -p [opts] [PROMPT]                # PROMPT positional or from stdin
  --name NAME                           # named session (default: anon-<rand>, auto-kill)
  --resume NAME                         # attach to existing NAME; don't auto-kill
  --cwd PATH                            # default $PWD
  --model opus|sonnet|haiku
  --output-format text|json             # default: text
  --allowed-tools "Read,Write,..."
  --timeout 10m
```

Flow:
1. Parse argv, resolve prompt (arg or stdin).
2. Resolve target session: `--resume` → must exist; `--name` → create-or-reuse; else → spawn anonymous.
3. Snapshot `events/stop` mtime.
4. `send-keys` the prompt (use `load-buffer` + `paste-buffer` if multi-line).
5. Wait until mtime advances or timeout.
6. `JsonlReader.lastAssistantMessage(session.jsonlPath)`.
7. Write to stdout in requested format.
8. If anonymous: kill + cleanup. Else: leave alive.
9. Exit 0 (or non-zero with typed error → stderr).

### 9b. Supervisor verbs (CLI + MCP)

```
rctrl spawn --name reviewer --cwd ./review [--model sonnet]
rctrl send reviewer "review the diff"
rctrl wait reviewer [--until stop|file:path|pattern:regex] [--timeout 5m]
rctrl status [NAME]                                # all if NAME omitted
rctrl ls                                           # short table
rctrl kill NAME
rctrl attach NAME                                  # tmux attach -t rctrl-NAME
rctrl read NAME                                    # last assistant message from JSONL
rctrl capture NAME [--lines 50]                    # last N tmux pane lines (for watching)
rctrl logs NAME                                    # tail events/log
```

`rctrl mcp` starts an MCP server exposing the same verbs as tools. Tool input schemas and CLI argv schemas come from one zod definition per verb. Single source of truth.

### 9c. `rctrl run workflow.yaml`

```yaml
workers:
  reviewer: { cwd: ./worktrees/review, model: sonnet }
  fixer:    { cwd: ./worktrees/fix,    model: opus  }

steps:
  - run: reviewer
    prompt: |
      Review PR #{{ env.PR }}. Write findings to review.md.
    wait: { stop: $session, timeout: 10m }
    outputs:
      review: file:./worktrees/review/review.md

  - run: fixer
    needs: [reviewer]
    prompt: |
      Apply these fixes:
      {{ steps.reviewer.outputs.review }}
    wait:
      all:
        - { stop: $session }
        - { file: ./worktrees/fix/tests-passed }
```

Executor: parse → validate (zod) → topological sort → execute respecting `needs` (parallel where possible) → propagate outputs → finalize.

**Templating** is intentionally tiny: `{{ env.X }}`, `{{ steps.NAME.outputs.X }}`, `{{ $session }}`. No expressions, no conditionals, no loops. Power users write shell scripts that call `rctrl`.

## 10. Error handling

Typed errors thrown by adapters/operations, caught at the face boundary:

```ts
// core/errors.ts

class SessionNotFoundError extends Error { name = 'SessionNotFoundError'; constructor(public sessionName: string) { super(); } }
class SessionDeadError extends Error { name = 'SessionDeadError'; constructor(public sessionName: string, public reason: string) { super(); } }
class HookTimeoutError extends Error { name = 'HookTimeoutError'; constructor(public waitedMs: number) { super(); } }
class TmuxError extends Error { name = 'TmuxError'; constructor(public cmd: string, public stderr: string) { super(); } }
class JsonlMalformedError extends Error { name = 'JsonlMalformedError'; constructor(public path: string) { super(); } }
class WorkflowCycleError extends Error { name = 'WorkflowCycleError'; constructor(public workers: string[]) { super(); } }
class WaitTimeoutError extends Error { name = 'WaitTimeoutError'; constructor(public condition: WaitCondition) { super(); } }
```

Face layer maps error class → exit code (Unix convention: 0 success, 1 generic, 2 bad usage, 124 timeout, 130 SIGINT) or MCP error response.

## 11. Concurrency model

- **Each session is owned by one rctrl invocation per turn.** No locks needed because callers don't share sessions mid-turn.
- **`rctrl status` / `rctrl ls`** read atomic files; tolerate races.
- **Wakeups** are file events via chokidar. No polling.
- **Cancellation** propagates via `AbortSignal`; every operation accepts one. SIGINT triggers graceful teardown (anonymous sessions get killed, named sessions stay alive).

## 12. Known landmines (designed around)

| Landmine | Mitigation |
|---|---|
| **Multi-line prompts** break `tmux send-keys -l` | Use `tmux load-buffer` + `paste-buffer` for any prompt containing `\n` |
| **Human attaches mid-flight** and types | Document: sessions are owned by rctrl while busy. Optionally detect via tmux `#{client_count}` and warn on `send`. |
| **Permission prompts** stall the turn (no Stop fires) | `rctrl -p` defaults match `claude -p` (whatever those are — TBD §13). Users should set `--allowed-tools` or `--dangerously-skip-permissions` as needed. |
| **Cold start** is 3–5s per call without pool | README is honest: "first call to a new session is slow; use `--name` for repeat calls" |
| **Concurrent `rctrl send` to same session** | mtime snapshot per caller handles it correctly — each waits for *their* Stop. But the Claude TUI gets two prompts crashed together. Document as "don't do that". |
| **First-run noise** (welcome screens, tips) | rctrl writes a settings overlay on session spawn that disables them |

## 13. Open questions (verify before baking in)

1. **Stop hook semantics.** Does Stop fire *only* at end-of-turn, or also at mid-turn tool-use stops? If the latter, our wait logic spuriously wakes early. Check Anthropic's hook docs.

2. **JSONL write ordering vs Stop hook firing.** Does Claude flush JSONL to disk *before* the hook fires? If not, there's a race where reading too eagerly yields a truncated last message. Mitigation: re-read after a short settle or watch JSONL for inactivity.

3. **`claude -p` defaults for tools/permissions.** What are they exactly? `rctrl -p` should mirror to be a true drop-in.

4. **Settings file collision.** If the cwd already has `.claude/settings.local.json`, we must merge (or use a separate config path if Claude Code supports `--settings PATH`). Check.

5. **Multi-line prompt threshold.** Is `tmux send-keys -l` actually problematic for `\n`, or does `Enter` after each line work? Test before committing to `paste-buffer` complexity.

6. **JSONL session ID resolution.** Given a cwd, how do we know which `*.jsonl` is the *current* session's? Newest mtime? Match against tmux pane PID? Need to verify the file naming convention.

## 14. Testing strategy

```
test/
├─ unit/                # core/ — pure, fast, no I/O
│  ├─ wait.test.ts
│  ├─ workflow.test.ts
│  └─ types.test.ts
├─ integration/         # adapters/ — real tmux, temp $RCTRL_STATE
│  ├─ tmux.test.ts
│  ├─ hooks.test.ts
│  ├─ fs-state.test.ts
│  └─ jsonl.test.ts
└─ e2e/                 # full stack against a fake `claude` binary
   ├─ p-mode.test.ts
   ├─ supervisor.test.ts
   └─ workflow.test.ts
```

**Fake `claude` for e2e.** A small bash script (`test/fixtures/fake-claude.sh`) that:
- Reads stdin
- Writes a plausible JSONL conversation file
- Sleeps a configurable amount
- Calls the Stop hook script
- Exits

This lets us run e2e tests in CI without burning real Claude budget or depending on Anthropic uptime.

**Test discipline (per CLAUDE.md):** every fix and feature starts with a failing test.

**Runner:** `bun:test`. No additional framework.

## 15. Dependencies

```
@modelcontextprotocol/sdk    # MCP server
zod                          # validation: argv, YAML, MCP tool inputs, JSONL parsing
yaml                         # workflow parser
chokidar                     # fs.watch wrapper

(dev)
@types/node
typescript
bun                          # runtime + test + build
```

Five runtime deps. All pure JS, no native modules.

## 16. Directory layout

```
rctrl/
├─ src/
│  ├─ core/
│  │  ├─ types.ts
│  │  ├─ wait.ts
│  │  ├─ workflow.ts
│  │  ├─ errors.ts
│  │  └─ id.ts                 # session name generation
│  ├─ adapters/
│  │  ├─ tmux.ts               # send-keys, capture-pane, new-session, paste-buffer
│  │  ├─ fs-state.ts           # meta.json read/write, session dir management
│  │  ├─ jsonl.ts              # last-assistant-message extraction
│  │  ├─ hooks.ts              # write settings.local.json, install hook
│  │  └─ fs-watch.ts           # chokidar wrapper, AbortSignal-aware
│  ├─ operations/
│  │  ├─ spawn.ts
│  │  ├─ send.ts
│  │  ├─ wait.ts
│  │  ├─ status.ts
│  │  └─ kill.ts
│  ├─ faces/
│  │  ├─ cli.ts                # argv dispatch
│  │  ├─ p.ts                  # `rctrl -p`
│  │  ├─ workflow.ts           # YAML executor
│  │  └─ mcp.ts                # MCP server
│  └─ main.ts                  # entry point
├─ hooks/
│  └─ stop.sh                  # gets copied to ~/.rctrl/hooks/ on first run
├─ test/
│  ├─ unit/
│  ├─ integration/
│  ├─ e2e/
│  └─ fixtures/
│     └─ fake-claude.sh
├─ docs/
│  ├─ architecture.md          # v1, kept for reference
│  ├─ architecture-v2.md       # this file
│  ├─ workflows.md
│  ├─ cli-reference.md
│  └─ tos.md
├─ scripts/
│  └─ build.ts                 # `bun build --compile`
├─ examples/
│  ├─ p-drop-in.sh
│  ├─ review-then-fix.yaml
│  └─ supervisor-prompt.md
├─ package.json
├─ tsconfig.json
├─ README.md
└─ LICENSE
```

## 17. What v1 does NOT do (deliberate scope guardrails)

- No session pool (anonymous = spawn-and-die; named = explicit lifecycle).
- No `stream-json` output format.
- No remote / distributed sessions. Local tmux only.
- No web UI. `rctrl status` / `rctrl logs` are the UI.
- No automatic worktree management. `--cwd` paths must exist.
- No agent-CLI abstraction. Claude Code only; aider/codex deferred.
- No keystroke jitter / anti-fingerprinting. We don't pretend to be human.
- No retry/circuit-breaker primitives. Failed steps fail the workflow.
- No templating logic in YAML beyond `{{var}}` substitution. No conditionals, loops, expressions.

## 18. Implementation order

Strict bottom-up. Each step gates on its tests passing.

1. **`core/`** — types, errors, wait predicate compiler, workflow graph. Pure, fully unit-testable in isolation.
2. **`adapters/tmux.ts`** + integration test (real tmux server, temp socket).
3. **`adapters/fs-state.ts`** + **`hooks.ts`** + **`fs-watch.ts`** + integration tests.
4. **`adapters/jsonl.ts`** (last-message extraction) + integration test with fixture JSONL.
5. **`operations/`** (spawn, send, wait, status, kill) + integration tests.
6. **`faces/cli.ts`** (argv parsing, verb dispatch) + verb-level tests.
7. **`faces/p.ts`** (`rctrl -p`) + e2e test with fake-claude.
8. **`faces/workflow.ts`** (YAML executor) + e2e test.
9. **`faces/mcp.ts`** (MCP server) + manual smoke test from Claude Code.
10. **`scripts/build.ts`** (Bun `--compile`).
11. **Final audit** — read every file, verify S.U.P.E.R. compliance, check for slop/bloat, re-run all tests.

Open questions in §13 get resolved during steps 2–4 (when we touch the relevant adapters). Anything that turns out wrong rolls back to this doc as a v3.
