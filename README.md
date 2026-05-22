# rctrl

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/jahala/rctrl/ci.yml?branch=master)](https://github.com/jahala/rctrl/actions)

Remote-control interactive agent CLIs — **Claude Code, Codex, Gemini** — over tmux. One binary, three faces, one provider abstraction.

Anthropic, OpenAI, and Google all priced their `-p`/`--print` modes at API rates while leaving the interactive TUI on subscription. `rctrl` gives you a programmatic surface — CLI, MCP server, YAML workflows — over the *interactive* binary of whichever vendor you're paying. Subscription-billed throughout.

## `rctrl -p` — drop-in for `claude -p` / `codex -p` / `gemini -p`

```bash
# Before
claude -p "summarise $FILE" --model sonnet --allowedTools Read

# After — same flags, subscription billing, your choice of provider
rctrl -p "summarise $FILE" --provider claude --model sonnet --allowedTools Read
rctrl -p "summarise $FILE" --provider codex  --model o4-mini
rctrl -p "summarise $FILE" --provider gemini --model gemini-2.5-pro
```

`--provider` defaults to `claude` for backward compatibility. All other flags pass through: `--model`, `--allowedTools`, `--output-format`, `--timeout`.

Cold-start cost is ~3–5s on the first call to a new session. Use `--name` to keep a session warm across calls:

```bash
rctrl -p --name analyst --provider claude "first question"
rctrl -p --resume analyst "follow-up"   # reuses the warm session, same provider
```

## Supervisor mode

Spawn named sessions and drive them from a parent agent (or shell script):

```bash
rctrl spawn --name reviewer --provider claude --cwd ./worktrees/review --model sonnet
rctrl spawn --name fixer    --provider codex  --cwd ./worktrees/fix    --model o4-mini
rctrl send reviewer "review the diff in $PWD and write findings to review.md"
rctrl wait reviewer
rctrl read reviewer
```

A single supervisor can drive workers from different providers concurrently. The provider is recorded in `meta.json` per session so `send`/`wait`/`read`/`kill` work the same way regardless.

`rctrl mcp` exposes the same verbs as MCP tools, so a supervisor agent can dispatch and watch workers without leaving its own session:

```bash
rctrl mcp    # MCP server on stdio — add to .mcp.json
```

Full verb list: `spawn`, `send`, `wait`, `status`, `ls`, `kill`, `attach`, `read`, `capture`, `logs`, `run`, `mcp`.

## Workflow mode

Declarative multi-agent pipelines, optionally mixing providers per step:

```yaml
workers:
  reviewer:
    provider: claude
    model: sonnet
    cwd: ./worktrees/review
  fixer:
    provider: codex
    model: o4-mini
    cwd: ./worktrees/fix

steps:
  - run: reviewer
    prompt: "Review PR #{{ env.PR }}. Write findings to review.md."
    wait: { stop: $session, timeout: 10m }
    outputs:
      review: file:./worktrees/review/review.md

  - run: fixer
    needs: [reviewer]
    prompt: "Apply these fixes:\n{{ steps.reviewer.outputs.review }}"
    wait:
      all:
        - { stop: $session }
        - { file: ./worktrees/fix/tests-passed }
```

```bash
rctrl run review-then-fix.yaml
```

Steps run in parallel where `needs` allows. Templating is intentionally minimal: `{{ env.X }}`, `{{ steps.NAME.outputs.X }}`, `{{ $session }}`.

## Install

```bash
bun install && bun run build
```

Homebrew tap coming. For now, build from source.

## Requires

- `tmux` >= 3.0
- macOS or Linux
- At least one provider CLI installed and authenticated with an active subscription:
  - `claude` (Claude Pro / Max)
  - `codex` (ChatGPT Plus / Pro / Team / Enterprise)
  - `gemini` (Google AI Pro / Ultra)

Providers without their binary installed simply can't be selected. `rctrl spawn --provider gemini` will fail loudly when tmux can't exec `gemini`.

## Architecture

No daemon. tmux is the daemon; `~/.rctrl/` is the state store. Every `rctrl` invocation is short-lived. Completion detection uses each provider's native lifecycle hook (Claude's `Stop`, Codex's `Stop`, Gemini's `AfterAgent`) — not terminal scraping. Agent output is read from each provider's transcript file, never from `capture-pane`.

Providers are pluggable via a small interface (`src/core/providers/types.ts`). Adding a 4th CLI is a `~150 LOC` implementation, not a rewrite. See [`docs/architecture-v3.md`](docs/architecture-v3.md) for the full design.

## Positioning

This tool exists because of the API/subscription billing split that all three major vendors have adopted. Aimed at solo developers automating their own work — not for commercial resale, not for evasion. See [`docs/tos.md`](docs/tos.md) for the longer version.

## Sister project

[**walkie-clawkie**](https://github.com/jahala/walkie-clawkie) — push-to-talk messaging between agents while their sessions are running. Complementary, not overlapping: rctrl dispatches and waits; walkie-clawkie lets sessions talk to each other mid-turn.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Test first — every fix and feature starts with a failing test.

## License

MIT — see [LICENSE](LICENSE).
