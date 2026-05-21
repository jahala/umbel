# Contributing to rctrl

## Setup

```sh
bun install
brew install tmux   # macOS; Linux: sudo apt-get install -y tmux
bun test
```

## Architecture

See [docs/architecture-v2.md](docs/architecture-v2.md) for a full walkthrough of how rctrl is structured and how the pieces fit together.

## Test-first discipline

Every bug fix and new feature starts with a failing test. If you can't write a test that fails, the bug or feature isn't understood well enough yet.

For end-to-end tests, rctrl uses a fake-claude fixture — a lightweight stand-in that exercises the CLI without burning real Claude API budget. **Never call the real Claude API in CI.**

## Style

[Biome](https://biomejs.dev) enforces formatting and linting. Before pushing:

```sh
bun run lint:fix   # auto-fix what can be auto-fixed
bun run lint       # verify clean
```

## Pre-commit checklist

Make sure this passes before opening a PR:

```sh
bun run check   # typecheck + lint + test
```

CI runs the same checks and will block merge on failure.
