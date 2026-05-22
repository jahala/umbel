# rctrl — Project Guidelines for Claude Code

## What this is

`rctrl` remote-controls the interactive `claude` TUI (and similar agent CLIs) over tmux. One TypeScript binary, three faces:

- `rctrl -p [PROMPT]` — drop-in for `claude -p`, but routed through the interactive TUI (subscription-billed).
- `rctrl spawn|send|wait|status|kill` (also via MCP) — supervisor verbs for agent-as-supervisor orchestration.
- `rctrl run workflow.yaml` — declarative pipelines.

**Read `docs/architecture-v3.md` before writing code.** It's the canonical multi-CLI design.

## Non-negotiable principles

1. **S.U.P.E.R.** — Side effects at the edge, Uncoupled logic, Pure & total functions, Explicit data flow, Replaceable by value. Lower layers know nothing about upper layers.
2. **Test first.** No fix or feature without a failing test that demonstrates the need. Fake `claude` binary (`test/fixtures/fake-claude.sh`) for e2e — never burn real subscription budget in CI.
3. **No daemon.** tmux is the daemon. Filesystem is the state store. Every `rctrl` invocation is short-lived.
4. **Files as IPC, JSONL as truth.** Hook events are file touches; `chokidar` is the event bus. Agent output is read from `~/.claude/projects/.../session.jsonl`, NEVER from `capture-pane` (which is for watching, not parsing).
5. **Throw typed errors, catch at face boundary.** No `Result<T,E>` library. Discriminated `Error` subclasses in `src/core/errors.ts`, caught and mapped to exit codes / MCP responses at the faces layer.
6. **Single zod schema per concept.** Argv parser, MCP tool schema, and YAML validation all share the same zod definitions. No three-times-defined types.

## Architecture layers (strict downward dependency)

```
faces/        cli  |  mcp  |  workflow  |  -p       ← side-effecty user surfaces
operations/   spawn  send  wait  status  kill      ← composition of adapters
adapters/     tmux  fs-state  hooks  fs-watch  jsonl  ← thin I/O wrappers
core/         types  errors  wait  workflow  id    ← pure, no I/O, unit-testable
```

Adapters are injected into operations. Operations are called by faces. **Nothing reaches across layers.**

## Stack

- TypeScript (strict mode) + Bun runtime + single-binary build via `bun build --compile`.
- Dependencies: `@modelcontextprotocol/sdk`, `zod`, `yaml`, `chokidar`. No native modules.
- Tmux is the substrate (runtime requirement, not dev).
- Tests via `bun:test`.
- Lint/format via `biome`.

## State on disk

```
~/.rctrl/                          # default; override via $RCTRL_STATE
├─ sessions/<name>/
│  ├─ meta.json                    # Session struct
│  └─ events/{stop, log}           # hook fires touch stop; log appends timestamps
├─ hooks/stop.sh                   # global, sessions reference it
└─ workflows/<run-id>/             # workflow run state
```

A session named `foo` lives in tmux as `rctrl-foo`. Anonymous sessions get `anon-XXXXXX`, killed on exit.

## The Stop hook (keystone)

Three lines, installed once globally:

```bash
#!/usr/bin/env bash
set -euo pipefail
state="${RCTRL_STATE:?}/sessions/${RCTRL_SESSION_ID:?}"
mkdir -p "$state/events"; touch "$state/events/stop"
date +%s%N >> "$state/events/log"
```

Wait semantics: **mtime snapshot of `events/stop` before send → watch for mtime advance → done.** Handles "Stop fired before we started watching" and concurrent waiters correctly.

## Claude Code flags we lean on

- `--settings '<inline-json>'` — pass hook config inline (no settings.local.json collision)
- `--session-id <uuid>` — control JSONL filename
- `--allowedTools "Read,Write,..."` — permission scope without prompts
- Do NOT use `--bare` — it skips hooks, which are our keystone.
- Do NOT use `--tmux` / `--worktree` — rctrl manages tmux itself for predictability.

## Open questions (verify before baking — see docs/architecture-v3.md §14)

If you encounter behavior that contradicts the design, STOP and update the architecture doc before working around it.

## Style

- Match surrounding code. Greenfield: ES modules, `.ts` extension in imports (Bun resolves), `const` over `let` over `var`, narrow types, prefer functions over classes (except for typed Errors).
- No comments unless WHY is non-obvious. Identifiers should self-document.
- No backwards-compatibility shims; no half-finished implementations; no TODOs left in committed code.
- Make the SMALLEST reasonable change.

## What NOT to do

- No `console.log` debugging in committed code. Use the structured logger (stderr only — never stdout, which is the `-p` response channel).
- No mocks in e2e tests. Use the fake-claude fixture.
- No `--bare` mode on workers (skips hooks → breaks rctrl).
- No screen-scraping the tmux pane for agent output. Use JSONL.
- No bypassing the layer boundaries. Operations don't shell out directly — they go through adapters/tmux.ts.
- No `git reset` (per global CLAUDE.md) — use `trash` for safe deletion.
