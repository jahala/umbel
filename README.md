# rctrl

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/jahala/rctrl/ci.yml?branch=master)](https://github.com/jahala/rctrl/actions)

Remote-control interactive `claude` over tmux. One binary, three faces.

Anthropic priced `claude -p` at API rates but left the interactive TUI on subscription. `rctrl` gives you a programmatic surface — CLI, MCP server, YAML workflows — over the *interactive* binary. Subscription-billed throughout.

## `rctrl -p` — drop-in for `claude -p`

```bash
# Before
claude -p "summarise $FILE" --model sonnet --allowedTools Read

# After — same flags, subscription billing
rctrl -p "summarise $FILE" --model sonnet --allowedTools Read
```

All flags pass through: `--model`, `--allowedTools`, `--output-format`, `--timeout`.

Cold-start cost is ~3–5s on the first call to a new session. Use `--name` to keep a session warm across calls:

```bash
rctrl -p --name analyst "first question"
rctrl -p --name analyst "follow-up"   # reuses the warm session
```

## Supervisor mode

Spawn named sessions and drive them from a parent agent (or shell script):

```bash
rctrl spawn --name reviewer --cwd ./worktrees/review --model sonnet
rctrl send reviewer "review the diff in $PWD and write findings to review.md"
rctrl wait reviewer
rctrl read reviewer
```

`rctrl mcp` exposes the same verbs as MCP tools, so a supervisor agent can dispatch and watch workers without leaving its own session:

```bash
rctrl mcp    # MCP server on stdio — add to .mcp.json
```

Full verb list: `spawn`, `send`, `wait`, `status`, `ls`, `kill`, `attach`, `read`, `capture`, `logs`, `run`, `mcp`.

## Workflow mode

Declarative multi-agent pipelines:

```yaml
workers:
  reviewer: { cwd: ./worktrees/review, model: sonnet }
  fixer:    { cwd: ./worktrees/fix,    model: opus }

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

- tmux >= 3.0
- macOS or Linux
- An interactive `claude` install (Claude Pro or Max subscription)

## Architecture

No daemon. tmux is the daemon; `~/.rctrl/` is the state store. Every `rctrl` invocation is short-lived. Completion detection uses Claude's native `Stop` hook — not terminal scraping. Agent output is read from `~/.claude/projects/.../session.jsonl`, never from `capture-pane`.

See [`docs/architecture-v2.md`](docs/architecture-v2.md) for the full design, including the layered architecture, session lifecycle, wait predicate algebra, and open question findings.

## Positioning

This tool exists because of Anthropic's API/subscription billing split. Aimed at solo developers automating their own work with a Claude subscription — not for commercial resale, not for evasion. See [`docs/tos.md`](docs/tos.md) for the longer version.

## Sister project

[**walkie-clawkie**](https://github.com/jahala/walkie-clawkie) — push-to-talk messaging between agents while their sessions are running. Complementary, not overlapping: rctrl dispatches and waits; walkie-clawkie lets sessions talk to each other mid-turn.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Test first — every fix and feature starts with a failing test.

## License

MIT — see [LICENSE](LICENSE).
