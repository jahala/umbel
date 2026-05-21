# rctrl and Anthropic's Terms of Service

## The mismatch

Anthropic prices the interactive `claude` TUI under subscription billing (Pro, Max, Team) and the `claude -p` / SDK path under API billing. These are different products at different prices. The interactive binary is designed for a human at a terminal; the API is designed for programmatic use. A developer who pays for a subscription but wants to automate their own workflows hits a wall: automation routes through the API, which charges separately per token.

## What rctrl does

rctrl provides a programmatic surface — CLI, MCP, YAML — over the interactive `claude` binary by driving it through tmux. It does not call the Anthropic API. Every prompt goes through the same interactive session that a human would use. From Anthropic's infrastructure perspective, rctrl sessions look like interactive usage, because they are interactive usage — the TUI is running, hooks fire, the JSONL log is written exactly as in a normal session. rctrl is a productivity tool for subscription holders who want to automate their own work without paying API rates on top of their subscription.

## Spectrum of use

**Defensible — what rctrl is designed for:**

- A solo developer running several review or refactor sessions in parallel across git worktrees, each session doing work that would otherwise require their full attention.
- CI pipelines on personal or small-team projects where the developer is the owner of the subscription and the work is work they would have done manually.
- An agent-as-supervisor pattern: one Claude session orchestrating several other Claude sessions, all belonging to the same user, doing the same user's work.

**Greyer — use with judgment:**

- Scheduled batch jobs that run overnight or on cron while you are not present and not actively directing the work. This is farther from "a human at a terminal" than Anthropic likely intends. The volume and pattern may draw attention.
- High-throughput automation that consistently saturates the session limit or generates usage far above typical interactive patterns.

**Indefensible — do not do this:**

- Building a commercial product or SaaS on top of rctrl that serves other users' requests using your subscription. This is subscription abuse, not productivity automation.
- Using rctrl to provide API-equivalent access to others, circumventing Anthropic's API pricing at scale.
- Reselling rctrl-powered capacity in any form.

## Risk to users

rctrl works because Anthropic has not closed the gap between interactive and programmatic use at the binary level. That gap could be closed. Specifically:

- Anthropic could add a runtime check to the interactive binary that detects tmux-driven non-interactive input and refuses to proceed or routes to API billing.
- Accounts that are flagged for high-volume automated usage could have their subscriptions reviewed or terminated.

Neither of these has happened as of this writing, but neither is implausible. The risk scales with how conspicuous your usage is. Automating a handful of parallel sessions for your own work is not conspicuous. Running hundreds of sessions continuously is.

Mitigation is straightforward: use rctrl as a productivity tool, not as a billing arbitrage strategy. If your workload is large enough that you are concerned about the terms, you should be using the API.

## No relationship with Anthropic

rctrl is an independent project. It is not endorsed by Anthropic, not affiliated with Anthropic, and not sanctioned by Anthropic in any way. Anthropic has not reviewed this software. The name "Claude" and related marks belong to Anthropic. rctrl simply drives the publicly available `claude` binary that Anthropic distributes to subscribers.

Use it accordingly.
