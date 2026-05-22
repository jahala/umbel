# Multi-CLI support — analysis & v2 plan

> Status: **v1 is Claude-only by deliberate scope**. This doc captures the research
> for v2 multi-CLI so we don't redo the thinking. Not built yet.

## Current state: four points of Claude coupling

| Concern | Location | Claude-specific assumption |
|---|---|---|
| **Binary launch** | `operations/spawn.ts`, `adapters/hooks.ts` | `claude --settings '<inline-json>' --session-id <uuid> --model <name>` |
| **Completion signal** | the Stop hook script + `wait` operation | Claude's `Stop` lifecycle event writing a file we touch |
| **Transcript location** | `adapters/jsonl.ts:discoverSessionJsonl` | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` |
| **Transcript format** | `adapters/jsonl.ts:lastAssistantMessage` | Claude's JSONL envelope shape |

Everything else (tmux, fs.watch, session lifecycle, state dir, MCP server, YAML workflows, CLI dispatch) is provider-agnostic.

## The major finding

**Codex, Gemini, and Claude all expose a hook system with near-identical contracts.** Each fires a lifecycle event at end-of-turn and passes a JSON payload on stdin to the hook script. The shared fields:

| Field | Claude | Codex | Gemini |
|---|---|---|---|
| `session_id` | ✓ | ✓ | ✓ |
| `transcript_path` | ✓ | ✓ (nullable) | ✓ |
| `cwd` | ✓ | ✓ | ✓ |
| `hook_event_name` | ✓ | ✓ | ✓ |

Sources: [Claude hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://developers.openai.com/codex/hooks), [Gemini hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md).

End-of-turn event names differ:
- Claude: `Stop`
- Codex: `Stop`
- Gemini: `AfterAgent`

Hook config delivery differs:
- Claude: `--settings '<inline-json>'` flag (no on-disk write needed)
- Codex: `~/.codex/hooks.json` or `<cwd>/.codex/hooks.json` or in `config.toml`
- Gemini: `~/.gemini/settings.json` or `<cwd>/.gemini/settings.json`

## The simplification we can make even for Claude alone

Right now `adapters/jsonl.ts:discoverSessionJsonl` does a directory snapshot diff to find which JSONL is ours. This is fragile and wastes ~100ms on every spawn.

**Better:** the hook payload already contains `transcript_path`. Change `hooks/stop.sh` to capture it:

```bash
#!/usr/bin/env bash
set -euo pipefail
state="${RCTRL_STATE:?}/sessions/${RCTRL_SESSION_ID:?}"
mkdir -p "$state/events"
# Capture transcript path from hook payload on stdin
payload=$(cat)
printf '%s' "$payload" | jq -r '.transcript_path // empty' > "$state/events/transcript-path"
touch "$state/events/stop"
date +%s%N >> "$state/events/log"
```

Then `operations/wait.ts` reads `events/transcript-path` after Stop fires. Dir-snapshot becomes a fallback only.

**This refactor is worth doing before multi-CLI** — it both simplifies the Claude path AND prepares us for any provider that gives us transcript_path.

## Provider abstraction (v2 design)

```ts
// src/core/providers/types.ts

export interface ProviderLaunchSpec {
  bin: string;                         // 'claude' | 'codex' | 'gemini'
  args: string[];                      // launch flags (model, allowedTools, etc.)
  env: Record<string, string>;         // RCTRL_STATE, RCTRL_SESSION_ID, plus provider-specific
  files: Array<{ path: string; content: string }>;
  //  ↑ extra files to write into cwd before launch (e.g. .codex/hooks.json,
  //    .gemini/settings.json). For Claude this is empty (we use --settings inline).
  //    Operations layer writes and then cleans up these files.
}

export interface AgentProvider {
  name: string;

  // Build everything needed to launch one session.
  buildLaunch(opts: {
    sessionId: string;
    cwd: string;
    hookScriptPath: string;            // path to our stop.sh
    model?: string;
    allowedTools?: string;
  }): ProviderLaunchSpec;

  // What hook event signals end-of-turn?
  stopEventName: string;               // 'Stop' for Claude/Codex, 'AfterAgent' for Gemini

  // Extract the final assistant response from the provider's transcript.
  // Different JSONL/JSON envelope shapes per provider.
  parseTranscript(content: string): string;

  // For providers without hooks (aider, etc.): use anchor-string instead.
  // Mutually exclusive with hook-based; if set, stopEventName is ignored.
  anchorStrategy?: {
    sentinel: string;                  // e.g. '<<<RCTRL_DONE>>>'
    promptSuffix: string;              // appended to user prompts so the model
                                       // is instructed to emit the sentinel
  };
}
```

Three providers planned:

### `ClaudeProvider`
- `buildLaunch` → `{ bin: 'claude', args: ['--settings', JSON, '--session-id', uuid, ...] }`
- `stopEventName: 'Stop'`
- `parseTranscript` = current `lastAssistantMessage`

### `CodexProvider`
- `buildLaunch` → writes `<cwd>/.codex/hooks.json` referencing our stop.sh, returns `bin: 'codex', args: [...]`
- `stopEventName: 'Stop'`
- `parseTranscript` = Codex's transcript envelope (TBD: research before building)
- Caveat: must merge into existing `.codex/hooks.json` if present, or use `<state>/codex-config` directory + `--config-dir` flag if Codex supports it

### `GeminiProvider`
- `buildLaunch` → writes `<cwd>/.gemini/settings.json`, returns `bin: 'gemini', args: [...]`
- `stopEventName: 'AfterAgent'`
- `parseTranscript` = Gemini's JSON envelope
- Caveat: same merge-or-isolate concern as Codex

### `AiderProvider` (longer-term)
- No hooks → uses `anchorStrategy`
- Operations layer detects sentinel by polling `capturePane`, not via fs.watch
- Less reliable; meant as escape-hatch for hookless CLIs

## What the user-facing surface looks like

```bash
rctrl spawn --name reviewer --provider claude --model sonnet
rctrl spawn --name fixer --provider codex --model o4-mini
rctrl spawn --name doc-checker --provider gemini --model gemini-2.5-pro
```

Default provider = `claude`. Per-step in workflows:

```yaml
workers:
  reviewer:
    provider: claude
    model: sonnet
  fixer:
    provider: codex
    model: o4-mini
```

## The "no hooks" hard problem (aider, opencode without plugin)

Anchor-string strategy:

```ts
anchorStrategy: {
  sentinel: '<<<RCTRL_DONE_8e2a>>>',  // random per session to prevent collision
  promptSuffix: '\n\nWhen you are completely finished, emit exactly this string on its own line and then exit: <<<RCTRL_DONE_8e2a>>>',
},
```

The operation layer:
1. Adds the suffix to every prompt sent to the worker
2. Polls `capturePane` every 500ms looking for the sentinel
3. Detects sentinel → marks turn complete
4. Reads response by capturing pane content between the previous sentinel and this one (cruder than JSONL, but workable)

Costs: 30-60 extra tokens per prompt, ~500ms detection latency. Reliability depends on the model not forgetting the suffix instruction over long conversations.

## When to build this

Order:
1. **Now (cheap, helps Claude):** refactor stop.sh + wait to use transcript_path from hook payload. ~30 LOC change.
2. **After smoke validates Claude end-to-end:** introduce `Provider` interface, refactor existing code to use `ClaudeProvider`. No behavior change. ~200 LOC refactor.
3. **After provider abstraction lands:** build `CodexProvider`. Adds ~150 LOC + transcript-format research + integration tests against fake-codex fixture.
4. **After Codex:** build `GeminiProvider`. ~150 LOC.
5. **Optional:** `AiderProvider` with anchor strategy. ~300 LOC (capture-pane polling is more work than hook-based).

Do NOT do steps 2–5 before smoke proves the underlying assumptions hold. Premature provider abstraction over an unverified design is the worst kind of refactor.

## Open questions for v2

1. Does Codex have an inline-config flag we missed? (`--hooks <path>`, env var?) Would eliminate the file-write requirement.
2. What's Codex's transcript JSONL envelope shape?
3. What's Gemini's transcript JSON envelope shape?
4. Do Codex and Gemini have a `--session-id` equivalent for controlling transcript filename?
5. Does the iTerm2-aware `claude --tmux` flag have an equivalent in Codex/Gemini that we'd want to avoid for the same predictability reasons?

These get answered as we build each provider — not now.
