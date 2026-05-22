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

## Smoke tests (real providers, local only)

Smoke tests live in `test/smoke/` and run against the actual installed provider binaries (Claude, Codex, Gemini). They are excluded from the default `bun test` and from CI.

Three suites, one gate:

| Suite | Files | Binary required |
|---|---|---|
| Claude | `p-mode`, `supervisor`, `multiline`, `resume`, `workflow` | `claude` (interactive TUI) |
| Codex | `codex-*` | `codex` |
| Gemini | `gemini-*` | `gemini` |

Each provider's tests auto-skip if its binary is not found on `$PATH` (or the well-known install location). You do not need all three installed to run the suite — providers with a missing binary emit a skip message and move on.

**When to run smoke tests:**

- After touching any wire-surface code: hook installation, `send-keys` / `paste-buffer` logic, Stop/AfterAgent hook detection, JSONL discovery, provider launch args.
- Before tagging a release.
- After a provider CLI version bump (the binary interface may have changed).

**How to run:**

```sh
RCTRL_SMOKE=1 bun run test:smoke
```

Run a single provider's suite only:

```sh
RCTRL_SMOKE=1 bun run test:smoke:claude
RCTRL_SMOKE=1 bun run test:smoke:codex
RCTRL_SMOKE=1 bun run test:smoke:gemini
```

Smoke files are organised by provider under `test/smoke/{claude,codex,gemini}/` and gated by `smokeDescribeFor(provider, …)` in `test/smoke/helpers.ts`.

**Requirements:**

- The provider binary installed and authenticated with an active subscription (not API key billing).
- `tmux` installed and available on `$PATH`.
- `RCTRL_SMOKE=1` set in the shell environment. Without this variable the smoke suite auto-skips every test.

**Cost:** Keep an eye on usage — each full run exercises real provider subscriptions. Claude runs at Haiku rates (~$0.01/run); Codex and Gemini costs depend on the model the provider defaults to.

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
