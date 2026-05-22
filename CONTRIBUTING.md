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

## Smoke tests (real claude, local only)

Smoke tests live in `test/smoke/` and run against the actual installed `claude` binary. They are excluded from the default `bun test` and from CI.

**When to run smoke tests:**

- After touching any wire-surface code: `--settings` inline JSON hook installation, `send-keys` / `paste-buffer` logic, Stop hook detection, JSONL discovery.
- Before tagging a release.
- After a `claude` CLI version bump (the binary interface may have changed).

**How to run:**

```sh
RCTRL_SMOKE=1 bun run test:smoke
```

**Requirements:**

- Interactive `claude` installed and authenticated with an active subscription (not API key billing).
- `tmux` installed and available on `$PATH`.
- `RCTRL_SMOKE=1` set in the shell environment. Without this variable the smoke suite auto-skips every test.

**Cost:** approximately $0.01 per full run at Haiku rates, charged to your Claude subscription. Keep an eye on usage if running frequently.

**Why local-only:** rctrl exists precisely to route through the interactive TUI rather than the API. Running smoke tests in CI against an API key would defeat the entire purpose of the tool and incur per-token billing. Smoke tests are a human-triggered gate, not a CI gate.

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
