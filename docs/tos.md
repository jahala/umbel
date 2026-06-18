# umbel and vendor Terms of Service

This applies to all three vendors umbel supports. The pricing-model split is the same in each case; the specific subscription names differ.

| Vendor | Subscription product | API product |
|---|---|---|
| Anthropic | Claude Pro / Max / Team | `claude -p` / Anthropic SDK |
| OpenAI | ChatGPT Plus / Pro / Team / Enterprise | `codex -p` / OpenAI API |
| Google | Google AI Pro / Ultra | `gemini -p` / Gemini API |

## The mismatch

Each vendor prices the interactive TUI under subscription billing and the equivalent `-p` / SDK path under API billing. These are different products at different prices. The interactive binary is designed for a human at a terminal; the API is designed for programmatic use. A developer who pays for a subscription but wants to automate their own workflows hits a wall: automation routes through the API, which charges separately per token.

## What umbel does

umbel provides a programmatic surface — CLI, MCP, YAML — over the vendor's interactive binary by driving it through tmux. It does not call any vendor's API. Every prompt goes through the same interactive session that a human would use. From the vendor's infrastructure perspective, umbel sessions look like interactive usage, because they are interactive usage — the TUI is running, hooks fire, the transcript log is written exactly as in a normal session. umbel is a productivity tool for subscription holders who want to automate their own work without paying API rates on top of their subscription.

## Spectrum of use

**Defensible — what umbel is designed for:**

- A solo developer running several review or refactor sessions in parallel across git worktrees, each session doing work that would otherwise require their full attention.
- CI pipelines on personal or small-team projects where the developer is the owner of the subscription and the work is work they would have done manually.
- An agent-as-supervisor pattern: one session orchestrating several others, all belonging to the same user, doing the same user's work — whether that's claude-on-claude, codex-on-codex, or mixed across providers.

**Greyer — use with judgment:**

- Scheduled batch jobs that run overnight or on cron while you are not present and not actively directing the work. This is farther from "a human at a terminal" than vendors likely intend. The volume and pattern may draw attention.
- High-throughput automation that consistently saturates session limits or generates usage far above typical interactive patterns.

**Indefensible — do not do this:**

- Building a commercial product or SaaS on top of umbel that serves other users' requests using your subscription. This is subscription abuse, not productivity automation.
- Using umbel to provide API-equivalent access to others, circumventing the vendor's API pricing at scale.
- Reselling umbel-powered capacity in any form.

## Risk to users

umbel works because none of the three vendors has closed the gap between interactive and programmatic use at the binary level. That gap could be closed by any of them. Specifically:

- A vendor could add a runtime check to the interactive binary that detects tmux-driven non-interactive input and refuses to proceed or routes to API billing.
- Accounts flagged for high-volume automated usage could have their subscriptions reviewed or terminated.

Neither of these has happened as of this writing, but neither is implausible. The risk scales with how conspicuous your usage is. Automating a handful of parallel sessions for your own work is not conspicuous. Running hundreds of sessions continuously is.

The risk is also per-vendor: a clamp-down by Anthropic doesn't affect Codex or Gemini and vice versa. Mixing providers is not a defense, just a different exposure surface.

Mitigation is straightforward: use umbel as a productivity tool, not as a billing arbitrage strategy. If your workload is large enough that you are concerned about the terms, you should be using the API.

## No relationship with any vendor

umbel is an independent project. It is not endorsed by, affiliated with, or sanctioned by Anthropic, OpenAI, or Google in any way. None of them has reviewed this software. The names "Claude", "Codex" (and "ChatGPT"), and "Gemini" and related marks belong to their respective owners. umbel simply drives the publicly available `claude`, `codex`, and `gemini` binaries that those vendors distribute to subscribers.

Use it accordingly.
