# rctrl

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/jahala/rctrl/ci.yml?branch=master)](https://github.com/jahala/rctrl/actions)

**Spawn other-provider agent workers from inside your agent session.** Drive `claude`, `codex`, or `gemini` interactively in tmux from a CLI, MCP server, or YAML workflow. One binary, one provider abstraction, three vendors — all subscription-billed.

## Claude Code orchestrating Codex (and Gemini, in parallel)

Your `claude` session can't spawn a `codex` session directly. With `rctrl mcp` configured, it can:

```jsonc
// .mcp.json
{ "mcpServers": { "rctrl": { "command": "rctrl", "args": ["mcp"] } } }
```

Your Claude Code agent now has `rctrl_spawn`, `rctrl_send`, `rctrl_wait`, `rctrl_read`, `rctrl_kill`, and `rctrl_help` in its toolbelt. Tell it:

> Spawn a Codex reviewer in `./worktrees/a` and a Gemini tester in `./worktrees/b`. Have them work in parallel, then synthesize their findings.

It'll stand up both workers, dispatch the prompts, wait for completion, and read their outputs. Three subscriptions, three roles, one orchestration. The host's context stays clean — it spends tokens on planning and synthesis, not on doing the work itself.

The server ships a server-level `instructions` block plus an on-demand `rctrl_help` tool (topics: `lifecycle`, `workflow`, `providers`) so your agent learns when to reach for rctrl and how to use it without being drowned in upfront context.

## Supervisor mode (CLI)

The same verbs from your shell — useful in scripts, cron, or when driving rctrl without an MCP host:

```bash
rctrl spawn --name reviewer --provider claude --cwd ./worktrees/review --model sonnet
rctrl spawn --name fixer    --provider codex  --cwd ./worktrees/fix    --model o4-mini
rctrl send reviewer "review the diff and write findings to review.md"
rctrl wait reviewer
rctrl read reviewer
```

A single supervisor can drive workers across providers concurrently. The provider is recorded in `meta.json` per session so `send`/`wait`/`read`/`kill` auto-route — no `--provider` needed after spawn.

Full verb list: `spawn`, `send`, `wait`, `status`, `ls`, `kill`, `attach`, `read`, `capture`, `logs`, `run`, `mcp`.

## Workflow mode

Declarative multi-step pipelines, mixed-provider per step:

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

## `rctrl -p` — drop-in for `claude -p` / `codex -p` / `gemini -p`

Same flags as the vendor `-p` mode, with provider as a parameter:

```bash
rctrl -p "summarise $FILE" --provider claude --model sonnet --allowedTools Read
rctrl -p "summarise $FILE" --provider codex  --model o4-mini
rctrl -p "summarise $FILE" --provider gemini --model gemini-2.5-pro
```

`--provider` defaults to `claude` for backward compatibility. Cold-start ~3–5s on first call; use `--name` / `--resume` to keep a session warm:

```bash
rctrl -p --name analyst --provider claude "first question"
rctrl -p --resume analyst "follow-up"   # reuses the warm session, same provider
```

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

Providers without their binary installed simply can't be selected. `rctrl spawn --provider gemini` fails loudly when tmux can't exec `gemini`.

## Architecture

No daemon. `tmux` is the daemon; `~/.rctrl/` is the state store. Every `rctrl` invocation is short-lived. Completion detection uses each provider's native lifecycle event (Claude `Stop`, Codex `Stop`, Gemini `AfterAgent`) — not terminal scraping. Agent output is read from each provider's transcript file, never from `capture-pane`. Providers are pluggable via a small interface (`src/core/providers/types.ts`) — adding a 4th CLI is a ~150 LOC implementation, not a rewrite. See [`docs/architecture-v3.md`](docs/architecture-v3.md) for the full design.

## Why this exists

Anthropic, OpenAI, and Google all priced their `-p` / `--print` modes at API rates while leaving the interactive TUI on subscription. `rctrl` gives you a programmatic surface over the *interactive* binary of whichever vendor you're paying — so the work you'd otherwise do by hand in the TUI runs against the subscription you already pay for, not per-token API billing on top.

Aimed at solo developers automating their own work. Not for commercial resale or evasion at scale. See [`docs/tos.md`](docs/tos.md) for the defensibility spectrum across all three vendors.

## Sister project

[**walkie-clawkie**](https://github.com/jahala/walkie-clawkie) — push-to-talk messaging between agents while their sessions are running. Complementary, not overlapping: rctrl dispatches and waits; walkie-clawkie lets sessions talk to each other mid-turn.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Test first — every fix and feature starts with a failing test.

## Support

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/jahala)

## License

MIT — see [LICENSE](LICENSE).
