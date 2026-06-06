# rctrl — Project Guidelines for Claude Code

## What this is

`rctrl` remote-controls the interactive `claude` TUI (and similar agent CLIs) over tmux. One TypeScript binary, three faces:

- `rctrl -p [PROMPT] --provider {claude,codex,gemini}` — drop-in for `claude -p` / `codex -p` / `gemini -p`, but routed through the interactive TUI (subscription-billed). Default provider: `claude`.
- `rctrl spawn|send|wait|status|kill` (also via MCP) — supervisor verbs for agent-as-supervisor orchestration. `spawn --provider` picks the worker; the provider is recorded in `meta.json` so subsequent verbs auto-route.
- `rctrl run workflow.yaml` — declarative pipelines with per-worker `provider:`.

**Read `docs/architecture-v3.md` before writing code.** It's the canonical multi-CLI design.

**Positioning & design filter** (full thesis: [`docs/positioning.md`](docs/positioning.md)). rctrl runs *one unit of agent work* reliably and returns a result the caller can branch on; **orchestration belongs to the caller, not rctrl.** Apply this filter to every change: **invest in the noun (the worker), not the verb (the orchestration)** — a new capability must be a per-worker primitive on CLI *and* MCP, composable by the caller, not new workflow syntax; if it can't be that, it probably doesn't belong here. Guardrails must be **enforced + external + looped** (check → reject + feedback + retry → halt), never advisory. Anchor identity to the neutral worker **contract**, not the substrate (tmux/subscription) — per-provider adapters absorb the churn; the contract stays stable. Keep the YAML face thin.

## Non-negotiable principles

1. **S.U.P.E.R.** — Side effects at the edge, Uncoupled logic, Pure & total functions, Explicit data flow, Replaceable by value. Lower layers know nothing about upper layers.
2. **Test first.** No fix or feature without a failing test that demonstrates the need. Fake binaries (`test/fixtures/fake-{claude,codex,gemini}.sh`) drive e2e — never burn real subscription budget in CI. Real-binary smoke tests live in `test/smoke/{claude,codex,gemini}/` and are gated on `RCTRL_SMOKE=1`.
3. **No daemon.** tmux is the daemon. Filesystem is the state store. Every `rctrl` invocation is short-lived.
4. **Files as IPC, JSONL as truth.** Hook events are file touches; `chokidar` is the event bus. Agent output is read from the provider's transcript file (location captured per-session from the Stop/AfterAgent hook payload), NEVER from `capture-pane` (which is for watching, not parsing).
5. **Throw typed errors, catch at face boundary.** No `Result<T,E>` library. Discriminated `Error` subclasses in `src/core/errors.ts`, caught and mapped to exit codes / MCP responses at the faces layer.
6. **Single zod schema per concept.** Argv parser, MCP tool schema, and YAML validation all share the same zod definitions. No three-times-defined types.

## Architecture layers (strict downward dependency)

```
faces/             cli  |  mcp  |  workflow  |  -p          ← side-effecty user surfaces
operations/        spawn  send  wait  status  kill          ← composition of adapters
adapters/          tmux  fs-state  hooks  fs-watch  jsonl   ← thin I/O wrappers
core/              types  errors  wait  workflow  id        ← pure
core/providers/    types  claude  codex  gemini  registry   ← pure provider abstraction
```

Adapters are injected into operations. Operations are called by faces. Providers are looked up by `name` from `core/providers/registry.ts`. **Nothing reaches across layers.**

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
│  ├─ meta.json                    # Session struct (includes provider, providerFiles)
│  └─ events/
│     ├─ stop                      # touch'd by stop.sh on each end-of-turn
│     ├─ transcript-path           # captured from hook payload (jq)
│     └─ log                       # appended nanosecond timestamps
├─ hooks/stop.sh                   # global, sessions reference it
└─ workflows/<run-id>/             # workflow run state
```

For Codex/Gemini, the provider also writes config files into the worker's `cwd` (`<cwd>/.codex/hooks.json`, `<cwd>/.gemini/settings.json`). Absolute paths are recorded in `meta.providerFiles` so `kill` can clean up.

A session named `foo` lives in tmux as `rctrl-foo`. Anonymous sessions get `anon-XXXXXX`, killed on exit.

## The Stop hook (keystone)

Installed once globally at `~/.rctrl/hooks/stop.sh`. Generic — works for Claude's `Stop`, Codex's `Stop`, and Gemini's `AfterAgent` events because all three include `transcript_path` in the payload on stdin:

```bash
#!/usr/bin/env bash
set -euo pipefail
state="${RCTRL_STATE:?}/sessions/${RCTRL_SESSION_ID:?}"
mkdir -p "$state/events"
payload=$(cat || true)
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$payload" | jq -r '.transcript_path // empty' > "$state/events/transcript-path" 2>/dev/null || true
fi
touch "$state/events/stop"
date +%s%N >> "$state/events/log"
```

Wait semantics: **mtime snapshot of `events/stop` before send → watch for mtime advance → done.** Handles "Stop fired before we started watching" and concurrent waiters correctly. The canonical source is `STOP_HOOK_SCRIPT` in `src/adapters/hooks.ts`; do not duplicate elsewhere.

Liveness fallback: a worker can die mid-turn (crash / non-zero exit) without ever firing the hook, so `events/stop` would never advance. `waitFor` polls `tmux has-session` and, when the session vanishes with the condition still unmet, returns `reason: 'dead'` instead of blocking until the timeout (previously a 30-min hang). The real condition is always evaluated *before* the liveness probe, so a turn that fired stop and then exited still resolves as `stop`.

Needs-input detection (the inverse keystone): a worker blocked on a prompt (a permission ask, or idle) is *alive* and has *not* fired stop, so it would hang to the timeout. A second global hook `notify.sh` (`NOTIFY_HOOK_SCRIPT`) touches `events/notification` on those events; `waitFor` watches it and settles `reason: 'input'` with the prompt message, so the caller can `send` an answer and `wait` again — the ping. Each provider registers its equivalent, all verified against the installed binary: Claude `Notification` (`permission_prompt` + `idle_prompt` in `buildSettingsJson`), Codex `PermissionRequest` (`.codex/hooks.json`), Gemini `Notification`/`ToolPermission` (`.gemini/settings.json`), OpenCode `permission.updated` (plugin event — `permission.asked` is v2-only). The opt-in pane-activity idle net (`waitFor`'s `idleTimeoutMs` → `reason: 'idle'`) is the universal backstop for a flaky or missing hook (none of the four exposes an *idle* event). `events/notification` is append-only JSONL (one line per hook fire); `core/notification.ts` classifies the latest line, so `rctrl_status` exposes `needsInput` + `needsInputReason` (permission/idle/question) + `pendingTool` (and `rctrl status --json` serves non-MCP watchers) — disambiguating a worker blocked on a prompt from one that's merely done-and-idle. `waitFor` settles `reason: 'input'` only for awaiting types; informational pings (`auth_success`, elicitation completion) are ignored. A per-worker reliability primitive — orchestration stays with the caller.

## Provider-specific surfaces

Each provider lives in `src/core/providers/<name>.ts` and contributes a `buildLaunch`, a `stopEventName`, and a `parseTranscript`. Per-vendor specifics:

**Claude** (`claude`)
- `--settings '<inline-json>'` carries the hook config (no `settings.local.json` collision).
- `--session-id <uuid>` controls the JSONL filename (we set our own).
- `--allowedTools "Read,Write,..."` scopes permissions without prompts.
- `stopEventName: 'Stop'`. Trust dialog is auto-dismissed for real-`claude` binaries only.
- Do NOT use `--bare` (skips hooks). Do NOT use `--tmux` / `--worktree` (rctrl manages tmux itself).
- Custom endpoints (DeepSeek, OpenRouter, local) are reached by the worker's `env` (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL`), not a new provider — same binary, same hooks. Don't add per-endpoint providers; it's an env concern. Recipe in `docs/cli-reference.md`.

**Codex** (`codex`)
- Hook config delivered via `<cwd>/.codex/hooks.json` (no inline-flag equivalent yet).
- `stopEventName: 'Stop'`. Transcript may be `null` per Codex docs; rctrl falls back to dir-snapshot.
- Known hazard: rctrl overwrites any pre-existing `<cwd>/.codex/hooks.json`. v4 plan is `CODEX_HOME`-style out-of-cwd config.

**Gemini** (`gemini`)
- Hook config delivered via `<cwd>/.gemini/settings.json`.
- `stopEventName: 'AfterAgent'` (not `Stop`). `matcher: "*"`, timeout in ms (Codex uses seconds).

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
