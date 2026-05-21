# rctrl — Architecture

> Remote-control interactive `claude` (and similar agent CLIs) over tmux.
> One binary, three faces: headless drop-in, supervisor, workflow runner.

## 1. What it is

`rctrl` is a single TypeScript binary (Bun-compiled) that drives interactive agent CLIs running inside tmux sessions.

It exists because Anthropic priced `claude -p` at API rates while leaving the interactive TUI on subscription billing. `rctrl` provides a programmatic surface (CLI, MCP, YAML) over the *interactive* binary so subscription users can automate their own work without paying API rates.

Three faces, one engine:

| Face | Command | For |
|---|---|---|
| Headless drop-in | `rctrl -p [PROMPT]` | swap-in for `claude -p` in scripts |
| Supervisor | `rctrl spawn / send / wait / status` (also MCP) | an agent orchestrating other agents |
| Workflow runner | `rctrl run workflow.yaml` | repeatable declarative pipelines |

## 2. Principles

- **No daemon.** tmux is already the daemon. The filesystem is the state store. Every `rctrl` invocation is short-lived.
- **Side effects at the edge** (S.U.P.E.R.). Pure core, thin I/O adapters, side-effecty faces.
- **Files as IPC.** Hook events, session state, workflow outputs — all observable on disk. Anything that wants to know what's happening can `fs.watch`.
- **Stop hook as keystone.** Completion detection uses Claude's native `Stop` hook, never terminal scraping.
- **JSONL as truth.** Agent output is read from `~/.claude/projects/.../session.jsonl`, never from `capture-pane`. `capture-pane` is for watching, not parsing.
- **One language, one binary.** TypeScript + Bun. Zero runtime deps for users (`brew install`).

## 3. Layered architecture

```
┌──────────────────────────────────────────────────────┐
│  faces/      cli  |  mcp  |  workflow  |  -p         │  ← argv dispatch, MCP server, YAML executor
├──────────────────────────────────────────────────────┤
│  operations/  spawn  send  wait  status  kill  pool  │  ← composition: orchestrate adapters
├──────────────────────────────────────────────────────┤
│  adapters/   tmux  fs-state  jsonl  hooks  fs-watch  │  ← thin I/O wrappers, one boundary each
├──────────────────────────────────────────────────────┤
│  core/       types  wait-predicates  workflow-graph  │  ← pure, no I/O, fully unit-testable
└──────────────────────────────────────────────────────┘
```

**Rule:** lower layers know nothing about upper layers. Adapters get injected into operations. Operations get injected into faces. Nothing reaches across.

## 4. Domain model

```ts
// core/types.ts

type SessionId = string & { __brand: 'SessionId' };
type WorkerName = string & { __brand: 'WorkerName' };

interface Session {
  id: SessionId;
  tmuxName: string;          // e.g. "rctrl-a1b2c3"
  cwd: string;               // worktree path
  jsonlPath: string;         // ~/.claude/projects/.../session.jsonl
  model?: 'opus' | 'sonnet' | 'haiku';
  status: 'booting' | 'idle' | 'busy' | 'dead';
  claimedBy?: number;        // PID of the rctrl process holding the lock
  createdAt: number;
  lastActiveAt: number;
}

interface Worker {                      // a named session (supervisor mode)
  name: WorkerName;
  session: SessionId;
}

interface WaitCondition {
  // discriminated union, see §7
}

interface WorkflowStep {
  run: WorkerName;
  prompt: string;
  wait?: WaitCondition;
  outputs?: Record<string, OutputSpec>;
  needs?: WorkerName[];
}

interface Workflow {
  workers: Record<WorkerName, WorkerSpec>;
  steps: WorkflowStep[];      // explicit; if omitted, derived from `needs:`
}
```

## 5. State on disk (source of truth)

```
$RCTRL_STATE/                              # defaults to $XDG_STATE_HOME/rctrl
├─ sessions/
│  └─ <session-id>/
│     ├─ meta.json            # Session struct, atomically written
│     ├─ lock                 # flock'd by the rctrl process that claimed it
│     ├─ jsonl-path           # symlink to the ~/.claude/projects/.../*.jsonl
│     ├─ events/
│     │  ├─ stop.<ns>         # each Stop hook fire writes one file
│     │  ├─ user-prompt.<ns>  # each UserPromptSubmit fires one
│     │  └─ latest -> stop.<ns>  # symlink to most recent
│     └─ logs/
│        └─ stderr.log
├─ workflows/
│  └─ <workflow-run-id>/
│     ├─ workflow.yaml        # snapshot
│     ├─ status.json          # per-step state
│     └─ outputs/<step>/...   # captured outputs
└─ hooks/
   ├─ stop.sh                 # the Stop hook (one copy, all sessions reference it)
   └─ user-prompt.sh
```

**Why filesystem.**
- Any `rctrl` invocation can answer "what's the state of X?" by reading files.
- Crash-safe: tmux survives `rctrl` crashes; state files survive both.
- Inspectable: `ls` and `cat` debug everything.
- Watchable: `fs.watch` is the event bus.

**Atomicity.** `meta.json` written via `O_EXCL` temp-then-rename. Status transitions use `flock` on `lock`. Pool claim is a single atomic op.

## 6. The Stop hook (the keystone)

A ~15-line bash script, installed once at `$RCTRL_STATE/hooks/stop.sh`. Each session's `.claude/settings.local.json` references it.

```bash
#!/usr/bin/env bash
# Inputs: stdin = hook JSON; env = RCTRL_SESSION_ID, RCTRL_STATE
set -euo pipefail
sid="${RCTRL_SESSION_ID:?}"
state="${RCTRL_STATE:?}/sessions/$sid"
ns=$(date +%s%N)
mkdir -p "$state/events"
cat > "$state/events/stop.$ns" <<< "$(cat)"   # persist hook payload
ln -sfn "stop.$ns" "$state/events/latest"
```

This is the only deterministic signal that a turn ended. `rctrl wait` watches `events/` with chokidar; new `stop.*` file → predicate fires.

## 7. Wait predicates (composable algebra)

```ts
// core/wait.ts
type WaitCondition =
  | { kind: 'stop'; session: SessionId }
  | { kind: 'user-prompt'; session: SessionId }
  | { kind: 'file'; path: string }
  | { kind: 'pattern'; session: SessionId; regex: string }
  | { kind: 'timeout'; ms: number }
  | { kind: 'all'; conditions: WaitCondition[] }
  | { kind: 'any'; conditions: WaitCondition[] }
  | { kind: 'not'; condition: WaitCondition };

// Pure compilation: a WaitCondition becomes
//   - a predicate () => boolean (checked against current state)
//   - a set of wake sources (files to watch, timers to set)
// The operation layer evaluates the predicate when any wake source fires.

interface CompiledWait {
  evaluate(state: SessionStateSnapshot): boolean;
  wakeSources: WakeSource[];
}

function compile(cond: WaitCondition): CompiledWait;  // pure
```

YAML form:
```yaml
wait: { stop: $session, timeout: 10m }       # implicit `all`
wait:
  any:
    - { stop: $session }
    - { file: ./out.md }
    - { timeout: 5m }
```

Default for all worker waits: `{ any: [{ stop: session }, { timeout: 30m }] }`. Never wait forever.

## 8. Session pool (cold-start mitigation)

Cold-spawning `claude` is ~3–5s. The pool keeps N idle sessions warm.

```ts
// operations/pool.ts
class Pool {
  claim(spec: SessionSpec): Promise<Session>;    // atomic idle→busy, spawn if none match
  release(session: Session, action: 'clear' | 'keep' | 'kill'): Promise<void>;
  gc(): Promise<{ reaped: number }>;             // drop dead/stale sessions
  warm(n: number, spec: SessionSpec): Promise<void>;  // pre-spawn
}
```

Claim algorithm:
1. List `sessions/*/meta.json` where `status=idle` and spec matches (model, cwd policy).
2. For each candidate, `flock -n lock`. First to win flips status to `busy` and returns.
3. If no candidate, spawn fresh.

Release policy is per-call (CLI flag `--keep-warm`, `--clear-context`, or `--kill`). Default for `-p`: `clear` (send `/clear`, return to pool).

## 9. The faces

### 9a. `rctrl -p` (headless drop-in)

```
rctrl -p [opts] [PROMPT]                # PROMPT positional or from stdin
  --model opus|sonnet|haiku
  --resume SESSION_ID
  --output-format text|json|stream-json
  --allowed-tools "Read,Write,..."
  --cwd PATH                            # defaults to $PWD
  --timeout 10m
```

Flow:
1. `parseArgs` → mode='p', prompt resolved (arg or stdin).
2. `Pool.claim({ model, cwd, resume })`.
3. `Operations.send(session, prompt)`.
4. `Operations.wait({ kind: 'stop', session })` (chokidar on events/).
5. `JsonlReader.lastAssistantMessage(session.jsonlPath)`.
6. Write to stdout in requested format. If `stream-json`: tail JSONL during step 4 instead of waiting.
7. `Pool.release(session, 'clear')`.
8. Exit 0 (or non-zero with error to stderr).

### 9b. `rctrl <verb>` (supervisor CLI + MCP)

Same verbs, two surfaces:

```
rctrl spawn  --name reviewer --worktree ./review --model sonnet
rctrl send   reviewer "review the diff"
rctrl wait   reviewer --until stop --timeout 5m
rctrl status [NAME]
rctrl kill   NAME
rctrl attach NAME                       # tmux attach
```

`rctrl mcp` starts an MCP server exposing the same verbs as tools (`rctrl_spawn`, `rctrl_send`, ...). Tool schemas are generated from the same zod schemas used by argv parsing — single source of truth.

### 9c. `rctrl run workflow.yaml`

```yaml
# review-then-fix.yaml
workers:
  reviewer:
    worktree: ./worktrees/review
    model: sonnet
  fixer:
    worktree: ./worktrees/fix
    model: opus

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

Executor: parse → validate (zod) → topological sort → execute → propagate outputs → finalize.

## 10. Error handling

```ts
// Discriminated error union, never `throw new Error`
type RctrlError =
  | { kind: 'pool-exhausted'; spec: SessionSpec }
  | { kind: 'session-dead'; id: SessionId; reason: string }
  | { kind: 'hook-not-fired'; id: SessionId; waitedMs: number }
  | { kind: 'tmux-error'; cmd: string; stderr: string }
  | { kind: 'jsonl-malformed'; path: string }
  | { kind: 'workflow-cycle'; workers: WorkerName[] }
  | { kind: 'timeout'; condition: WaitCondition };

// core + operations: return Result<T, RctrlError>
// faces: translate to exit codes / MCP error responses
```

Exit codes follow Unix convention: 0 success, 1 generic, 2 bad usage, 124 timeout, 130 SIGINT.

## 11. Concurrency model

- **Sessions** are owned by exactly one rctrl process at a time (via `flock`).
- **Reads** (status, list) never lock — they tolerate races by reading atomic files.
- **Wakeup** is event-driven via chokidar on `events/`. No polling.
- **Cancellation** propagates via `AbortSignal`. Every operation accepts one.

## 12. Testing strategy

```
test/
├─ unit/              # core/ — pure, fast, no I/O
│  ├─ wait-predicates.test.ts
│  ├─ workflow-graph.test.ts
│  └─ state-machine.test.ts
├─ integration/       # adapters/ — real tmux, temp $RCTRL_STATE
│  ├─ tmux.test.ts
│  ├─ hooks.test.ts
│  └─ jsonl.test.ts
└─ e2e/               # full stack against a fake `claude` (echo script)
   ├─ p-mode.test.ts
   ├─ supervisor.test.ts
   └─ workflow.test.ts
```

E2E tests use a fake `claude` binary (bash script that emits valid JSONL and fires hooks). Don't burn real subscription budget in CI.

Runner: `bun:test`. No additional framework.

**Discipline**: every fix and feature starts with a failing test (per CLAUDE.md).

## 13. Dependencies

```
@modelcontextprotocol/sdk    # MCP server
zod                          # validation everywhere (argv, YAML, MCP, JSONL)
yaml                         # workflow parser
chokidar                     # fs.watch (better cross-platform than native)
ansi-regex                   # only if we ever need to strip from capture-pane

(dev)
@types/node
typescript
bun                          # runtime + test + build
```

Bunfile imports stay minimal. Vendor-able if needed.

## 14. Directory layout (final)

```
rctrl/
├─ src/
│  ├─ core/
│  │  ├─ types.ts
│  │  ├─ wait.ts
│  │  ├─ workflow.ts
│  │  ├─ errors.ts
│  │  └─ id.ts
│  ├─ adapters/
│  │  ├─ tmux.ts
│  │  ├─ fs-state.ts
│  │  ├─ jsonl.ts
│  │  ├─ hooks.ts
│  │  └─ fs-watch.ts
│  ├─ operations/
│  │  ├─ spawn.ts
│  │  ├─ send.ts
│  │  ├─ wait.ts
│  │  ├─ status.ts
│  │  ├─ kill.ts
│  │  └─ pool.ts
│  ├─ faces/
│  │  ├─ cli.ts                # argv dispatch
│  │  ├─ p.ts                  # `rctrl -p` mode
│  │  ├─ workflow.ts           # YAML executor
│  │  └─ mcp.ts                # MCP server
│  └─ main.ts                  # entry point
├─ hooks/
│  ├─ stop.sh
│  └─ user-prompt.sh
├─ test/
│  ├─ unit/
│  ├─ integration/
│  └─ e2e/
├─ docs/
│  ├─ architecture.md          # this file
│  ├─ workflows.md
│  ├─ cli-reference.md
│  └─ tos.md                   # explicit positioning
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

## 15. What this design does NOT do (v1)

- No remote/distributed sessions. Local tmux only.
- No web UI / dashboard. `rctrl status` is the UI.
- No automatic worktree management. Worker `worktree:` paths must exist (user's responsibility).
- No agent-CLI abstraction layer. v1 is Claude Code only; generalization to `aider` / `codex` is a v2 concern.
- No keystroke jitter / anti-fingerprinting. We don't pretend to be human.
- No retry/circuit-breaker primitives. If a step fails, the workflow fails. Wrappers can add policy.

## 16. Implementation order

Strict order, each step has tests:

1. `core/` — types, errors, wait predicate compiler, workflow graph (pure, fully unit-testable in isolation).
2. `adapters/tmux.ts` + integration test against real tmux.
3. `adapters/fs-state.ts` + `adapters/hooks.ts` + `adapters/fs-watch.ts` + integration tests.
4. `adapters/jsonl.ts` (read + tail) + integration test with fixture files.
5. `operations/spawn` / `send` / `wait` / `kill` / `status` + integration tests.
6. `operations/pool` + integration tests.
7. `faces/cli.ts` (argv parser, dispatcher) + verbs.
8. `faces/p.ts` (`-p` mode) + e2e test with fake-claude.
9. `faces/workflow.ts` (YAML executor) + e2e test.
10. `faces/mcp.ts` (MCP server) + manual test from Claude Code.
11. `scripts/build.ts` (Bun compile) + `brew` tap setup (separate repo).
12. Final audit: read every file, verify S.U.P.E.R. compliance, check for slop/bloat.

Each step gates on the prior step's tests passing.
