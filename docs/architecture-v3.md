# rctrl — Architecture v3

> Remote-control interactive agent CLIs (Claude Code, Codex, Gemini) over tmux.
> One binary, three faces, **pluggable providers**.
>
> **Supersedes** `architecture-v2.md`. v2 is kept for decision history.

## 0. What changed from v2

| v2 | v3 | Why |
|---|---|---|
| Claude Code only | Provider abstraction with `ClaudeProvider`, `CodexProvider`, `GeminiProvider` | Codex and Gemini have near-identical hook lifecycles to Claude; the four points of provider-specific behavior can be cleanly abstracted (see §4) |
| Spawn-time JSONL discovery (`discoverSessionJsonl`) | Lazy resolution via `events/transcript-path` written by Stop hook from the payload | Real claude doesn't write the transcript until first message — discovery at spawn-time is impossible. The hook payload contains `transcript_path` for free. |
| Argv parser: short flags consume next non-dash arg | Short flags are ALWAYS boolean | `rctrl -p "prompt"` was eating the prompt. Caught by smoke testing; saved by root-cause investigation. |
| spawn passes full process.env to tmux | Curated allowlist: `PATH HOME USER LANG LC_ALL TZ TMPDIR FAKE_CLAUDE_*` | Passing `SHELL`/`PROMPT_COMMAND` triggers bash startup byte emission to the spawned process's stdin, racing the first send-keys. |
| `lastAssistantMessage` walks backward stopping at first non-assistant | Finds last assistant index, then walks back from there | Real claude appends `system`/`last-prompt`/`ai-title`/`permission-mode` metadata AFTER the assistant response. |
| `encodeCwd` literal slash replacement | `realpathSync` before encoding | macOS `/var/folders` resolves to `/private/var/folders`; claude encodes the resolved path. |
| No trust-dialog handling | `dismissTrustDialog` polls capture-pane and sends Enter when the prompt appears | Real claude shows a workspace-trust dialog on first launch in every fresh cwd. Gated on `isRealClaudeBin` so non-claude binaries don't pay the polling cost. |

Net: provider-agnostic core, sustained Claude Code support, and provider-shaped scaffolding for Codex and Gemini.

## 1. What it is

`rctrl` is a single TypeScript binary (Bun-compiled) that drives interactive agent CLIs running inside tmux sessions, with a pluggable provider interface so the same orchestration works against Claude, Codex, or Gemini.

It exists because Anthropic priced `claude -p` at API rates while leaving the interactive TUI on subscription billing. Same trade-off applies (or will) for other vendors. `rctrl` is the *interactive-TUI-as-API* layer.

Three faces, one engine, multiple providers:

| Face | Command | For |
|---|---|---|
| Headless drop-in | `rctrl -p [PROMPT]` | swap-in for `claude -p` / `codex -p` / `gemini -p` |
| Supervisor | `rctrl spawn --provider {claude,codex,gemini} ...` (also MCP) | agent orchestrating other agents |
| Workflow runner | `rctrl run workflow.yaml` (per-worker `provider:`) | declarative multi-agent pipelines, optionally mixed-provider |

## 2. Principles (unchanged from v2)

- **No daemon.** tmux is the daemon. The filesystem is the state store.
- **Side effects at the edge** (S.U.P.E.R.). Pure core, thin I/O adapters, side-effecty faces.
- **Files as IPC.** Hook events are file touches; `fs.watch` is the event bus.
- **Stop hook is the keystone.** Completion detection uses each provider's native lifecycle event.
- **JSONL/JSON as truth.** Agent output is read from the provider's transcript file, never from `capture-pane`.
- **One zod schema per concept** drives argv + MCP tool schemas + YAML validation.
- **Throw at the boundary.** Typed errors thrown in adapters/operations, caught and translated at faces.

## 3. Layered architecture

```
┌──────────────────────────────────────────────────────────────┐
│  faces/      cli  |  mcp  |  workflow  |  -p                 │  ← user surfaces
├──────────────────────────────────────────────────────────────┤
│  operations/  spawn  send  wait  status  kill  resolve-jsonl │  ← composition
├──────────────────────────────────────────────────────────────┤
│  adapters/   tmux  fs-state  hooks  fs-watch  jsonl          │  ← I/O wrappers
├──────────────────────────────────────────────────────────────┤
│  core/       types  errors  wait  workflow  id               │  ← pure
│  core/providers/  types  claude  codex  gemini  index        │  ← NEW: provider abstraction
└──────────────────────────────────────────────────────────────┘
```

`core/providers/` is pure — each provider exports a `buildLaunch`, a `stopEventName`, a `parseTranscript`, and optionally an `anchorStrategy`. No I/O.

## 4. Provider interface

```ts
// src/core/providers/types.ts

export interface ProviderLaunchSpec {
  bin: string;                  // 'claude' | 'codex' | 'gemini' | absolute path
  args: string[];               // launch flags (model, allowedTools, hook config)
  env: Record<string, string>;  // env vars to pass into tmux (provider-specific)
  files: Array<{ path: string; content: string; mode?: number }>;
  //   ↑ ephemeral files to write into the cwd before launch (e.g.
  //   .codex/hooks.json, .gemini/settings.json). Operations layer writes them
  //   and removes them on session kill. Empty for providers that support
  //   inline-config flags (Claude's --settings).
}

export interface AgentProvider {
  name: 'claude' | 'codex' | 'gemini' | 'aider' | string;

  buildLaunch(opts: {
    sessionId: string;          // rctrl session name (= tmux session suffix)
    cwd: string;
    hookScriptPath: string;     // absolute path to our stop.sh
    model?: string;
    allowedTools?: string;
  }): ProviderLaunchSpec;

  // Which lifecycle event name marks end-of-turn in this provider's hook
  // payload? rctrl's stop.sh is generic — it captures transcript_path from
  // whatever payload it gets. This field is informational + tests.
  stopEventName: string;        // 'Stop' for Claude/Codex, 'AfterAgent' for Gemini

  // Extract the final assistant text from the transcript file. Different
  // JSONL/JSON envelopes per provider.
  parseTranscript(content: string): string;

  // For providers without hook lifecycle (aider): anchor-string fallback.
  // Mutually exclusive with hook-based completion; the operations layer
  // checks this field to choose its wait strategy.
  anchorStrategy?: {
    sentinel: string;           // e.g. '<<<RCTRL_DONE_8e2a>>>'
    promptSuffix: string;       // appended to user prompts so the model
                                // is instructed to emit the sentinel
  };
}
```

The Stop hook script stays generic — it captures `transcript_path` from stdin via `jq` regardless of which provider fired it.

## 5. Per-provider summary

### ClaudeProvider (`src/core/providers/claude.ts`)
- `buildLaunch` → `bin: 'claude', args: ['--settings', JSON, '--session-id', uuid, '--model', model]`
- `files: []` — Claude supports inline `--settings`, no scratch files needed
- `stopEventName: 'Stop'`
- `parseTranscript`: walks backward from end of JSONL, finds last assistant index, joins consecutive assistant entries (handles thinking + text blocks; per real-claude trace findings)
- Trust dialog auto-dismiss via `isRealClaudeBin` gate

### CodexProvider (`src/core/providers/codex.ts`)
- `buildLaunch` → writes `<cwd>/.codex/hooks.json` referencing our stop.sh
- `files: [{ path: '.codex/hooks.json', content: hooksJsonStr }]` — operations layer cleans up on kill
- `stopEventName: 'Stop'`
- `parseTranscript`: Codex JSONL envelope (`event_msg` items, last `agent_message` is the response)
- No equivalent of `--session-id` for transcript filename — hook payload's `transcript_path` is the source of truth (may be `null` per Codex docs; rctrl falls back to dir-snapshot)

### GeminiProvider (`src/core/providers/gemini.ts`)
- `buildLaunch` → writes `<cwd>/.gemini/settings.json` with `AfterAgent` hook
- `files: [{ path: '.gemini/settings.json', content: settingsJsonStr }]`
- `stopEventName: 'AfterAgent'` (Gemini uses different event names)
- `parseTranscript`: Gemini transcript envelope (research per findings)

### AiderProvider (deferred — backlog)
- Hookless. Uses `anchorStrategy`.
- Operations layer polls `capturePane` for the sentinel.

## 6. Stop hook (provider-agnostic)

Three lines + jq extraction. **Unchanged from v2.1.** Works for Claude, Codex, Gemini because all three include `transcript_path` in their lifecycle payloads:

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

## 7. Session lifecycle

Identical to v2 (`booting → ready → busy → ready → dead`). The provider is just a parameter at spawn time and is recorded in `meta.json` so subsequent calls (`send`, `read`, etc.) know which transcript parser to use.

## 8. User-facing surface

### CLI

```bash
rctrl spawn --name reviewer --provider claude --model sonnet
rctrl spawn --name fixer    --provider codex  --model o4-mini
rctrl spawn --name docs     --provider gemini --model gemini-2.5-pro

rctrl -p --provider codex "summarize this PR"
```

Default provider: `claude` (backward compat with v2).

### Workflow YAML

```yaml
workers:
  reviewer:
    provider: claude     # default if omitted
    cwd: ./worktrees/review
    model: sonnet
  fixer:
    provider: codex
    cwd: ./worktrees/fix
    model: o4-mini

steps:
  - run: reviewer
    prompt: "Review PR #{{ env.PR }}"
    outputs:
      review: assistant_last_message
  - run: fixer
    needs: [reviewer]
    prompt: "Apply: {{ steps.reviewer.outputs.review }}"
```

### MCP

`rctrl_spawn` tool gains a `provider` field. Same MCP server, same engine.

## 9. State on disk (additions to v2)

```
~/.rctrl/
├─ sessions/<name>/
│  ├─ meta.json                    # Session struct — NEW field: provider
│  ├─ provider-files/              # NEW: provider-written files to clean up on kill
│  │  └─ <provider>.<filename>     # e.g. codex.hooks-json, gemini.settings-json
│  └─ events/
│     ├─ stop                      # touch'd by stop.sh
│     ├─ transcript-path           # NEW in v2.1: written from hook payload
│     └─ log
├─ hooks/stop.sh
└─ workflows/<run-id>/
```

`provider-files/` records what we wrote where, so kill can clean up.

## 10. Session meta.json schema

```ts
interface Session {
  name: SessionName;
  cwd: string;
  provider: string;              // NEW: 'claude' | 'codex' | 'gemini' | ...
  model?: string;                // NEW: provider-agnostic; model names differ per provider
  anonymous: boolean;
  createdAt: number;
  jsonlPath: string | null;      // null at spawn-time; resolved on first Stop
  providerFiles?: Array<{        // NEW: files written by provider, for cleanup
    absPath: string;
  }>;
}
```

`model` is now `string | undefined` (not the Claude-only enum) because Codex and Gemini have different model names.

## 11. The "no hooks" hard problem

For Aider (and any future hookless CLI), `anchorStrategy` provides a workable but inferior path:

```ts
anchorStrategy: {
  sentinel: '<<<RCTRL_DONE_8e2a>>>',
  promptSuffix: '\n\nWhen finished, emit exactly this string on its own line: <<<RCTRL_DONE_8e2a>>>',
},
```

Operations layer:
1. Adds `promptSuffix` to every prompt sent
2. Polls `capturePane` every 500ms looking for the sentinel
3. Sentinel found → mark turn complete
4. Reads response from pane content between previous and current sentinel

Cost: ~30-60 extra tokens per prompt, ~500ms detection latency. Reliability depends on the model honoring the instruction over long conversations.

Deferred to v4 — focus v3 on the three hook-based providers first.

## 12. Migration from v2

Existing rctrl users (Claude only) keep working because:
1. `provider: claude` is the default everywhere
2. Existing `Session` shape gains optional fields; old `meta.json` parses fine
3. CLI verbs accept `--provider` as a new optional flag

No breaking changes. `architecture-v2.md` stays as decision history.

## 13. Implementation order (this milestone)

Strict bottom-up. Each step gates on its tests passing.

1. **`src/core/providers/types.ts`** — `AgentProvider`, `ProviderLaunchSpec` interfaces. Pure types.
2. **`src/core/providers/claude.ts`** — `ClaudeProvider` implementation. Refactor of current spawn/hooks/jsonl-parse logic into provider methods. Existing tests must continue to pass with no behavior change.
3. **`src/core/providers/index.ts`** — registry: `{ claude: ClaudeProvider, codex: ..., gemini: ... }`. Default `claude`.
4. **Refactor `operations/spawn.ts`** — call `provider.buildLaunch` instead of inline claude args. Write `provider.files` into `provider-files/`, record absolute paths in meta.
5. **`operations/kill.ts`** — read meta.providerFiles, unlink them on kill.
6. **CLI/workflow/MCP**: thread `--provider` through.
7. **`test/fixtures/fake-codex.sh`** + **`test/fixtures/fake-gemini.sh`** — fixtures for integration testing.
8. **`src/core/providers/codex.ts`** + integration tests against fake-codex.
9. **`src/core/providers/gemini.ts`** + integration tests against fake-gemini.
10. **Smoke tests**: `test/smoke/codex-*.smoke.ts` + `test/smoke/gemini-*.smoke.ts`. Auto-skip if binary missing.
11. **Audit C**: race conditions, cleanup paths, error handling for the new surface.
12. **Docs**: README pitch update, cli-reference `--provider` flag, workflows `provider:` field, findings.md per-provider quirks.

## 14. Open questions (verify during implementation)

1. **Codex `--config-dir` flag**: does Codex support overriding the hook config directory via a CLI flag? Would eliminate the file-write-and-cleanup path. (TBD during fake-codex research.)
2. **Codex transcript_path nullability**: their docs say it "may be null". Under what circumstances? Does rctrl need a defensive code path that hits `discoverSessionJsonl`?
3. **Gemini inline-config flag**: any way to pass settings without a file on disk?
4. **Per-provider `--session-id` equivalents**: Codex and Gemini transcript filenames. Are they controllable?
5. **Model enum vs string**: should `meta.model` be a free-form string (current proposal) or a discriminated union per provider? Free-form is simpler; provider-validated is stricter.

These get answered when we build each provider.

## 15. What v3 does NOT do

- No remote/distributed sessions
- No web UI; `rctrl status` / `rctrl logs` are the UI
- No automatic worktree management
- No keystone retry/circuit-breaker primitives
- No automatic provider detection — user picks
- No cross-provider conversation forking (you can't take a Claude conversation and continue it in Codex)
- Aider/anchor-string strategy is deferred to v4

## 16. The pricing context (unchanged from v2)

Each major vendor priced their non-interactive (`-p`-style) mode at API rates while leaving interactive on subscription. This is the underlying reason rctrl exists. The trade-offs documented in `docs/tos.md` still apply per-provider — running automated workflows against a subscription is the gray zone; doing it commercially at scale is not defensible.

This is, plainly, a tool for solo developers parallelizing their own work. Multi-CLI doesn't change that — it just expands which subscription you're using.
