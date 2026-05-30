# rctrl — positioning

The strategic spine: what rctrl is, where it sits, and the rule that governs what gets
built. Technical design lives in [`architecture-v3.md`](architecture-v3.md); this is the *why*.

## What rctrl is

The reliable execution boundary for **one unit of agent work**. It turns a stochastic
agent — on any provider, that might crash, that returns prose — into a clean call:
**agent-as-a-(soon, verified-)function-call.** You hand it a task; it hands back a
result you can branch on.

## Where it sits

```
planner       what to build           (goal + acceptance criteria)
orchestrator  which-next + branching  (the graph)              ← the caller
rctrl         run ONE unit reliably + return a result          ← this
agent         the actual work         (stochastic)
tmux          substrate
```

rctrl runs one unit; **the caller owns the graph.** Done right, the orchestrator gets to
be pure control flow over trustworthy units — it never touches transport, completion
detection, liveness, output parsing, retries, or provider quirks.

## The contract (not YAML)

A typed call/return *signature* — one zod definition — projected over transports:

- **agent orchestrator** → MCP tool calls
- **code orchestrator** → CLI verb + JSON stdout
- **no orchestrator** → the YAML `run` mode (rctrl absorbs the orchestrator role; this is
  the *only* place YAML belongs — a whole DAG means rctrl *is* the orchestrator)

The signature the faces project from:

```
invoke(task, { provider, model, cwd, env, allowedTools, schema?, accept?, budget?, timeout })
  → { status, output, evidence{ trace, files, gates }, telemetry{ tokens, ctxPct, compacted } }
```

Stateful variant for multi-turn workers: `spawn → send/wait/read → kill`. The format is
cosmetic (JSON on the wire, YAML as authoring sugar); the **signature** is the contract.

## The edge — and what it is NOT

- **Edge: boundary instrumentation.** Clean completion *in* (provider hooks, not
  screen-scraping) + structured/compact result *out* (`actions`/`diff`, not pane dumps).
- **Structural moat: cross-provider neutrality.** No first-party vendor can orchestrate
  its competitors; only a neutral third party can. Everything else is a *craft* moat
  (instrumentation quality) — copyable by a funded competitor.
- **NOT billing.** Subscription billing is automatic for anything that drives the CLI —
  every competitor has it. It is not a differentiator.
- **NOT orchestration.** The DAG layer is crowded (n8n, Temporal, CAO) and belongs to the
  caller. Don't compete there.

## Durability — rctrl is a driver layer

Fragile in implementation (per-provider adapters churn with each vendor release), durable
in value (the contract is stable). It is valuable *because* providers churn — a neutral
interface that absorbs the change so the caller's logic never moves. Two disciplines keep
it valid:

1. **Anchor identity to the contract, not the substrate.** If a provider ships a clean
   external worker API, that becomes a new adapter and rctrl gets *easier*. Identity
   anchored to "the tmux subscription thing" dies on the next release; anchored to "the
   neutral worker contract" it rides the change.
2. **Run real-binary smoke on a schedule** to catch provider drift early — the fake-binary
   suite tests rctrl's *model*, not the provider's *current* behavior. Evals double as the
   drift detector: a model/harness change shows up as eval regressions.

## Design filter — apply to every proposed feature

- **Invest in the noun (the worker), not the verb (the orchestration).** A new capability
  must be a per-worker primitive on CLI **and** MCP, composable by the caller — not new
  workflow syntax. If it can't be that, it probably doesn't belong in rctrl.
- **Guardrails must be enforced + external + looped** (generate → objective check →
  reject + feedback + retry → halt + escalate), never advisory. rctrl's externality is
  what makes its checks credible — the verifier is outside the agent; cross-model
  verification is the strongest form.
- **Keep the YAML face thin.** It gets no capability the primitives don't get first.

## Today (shipped)

`spawn`/`send`/`wait`/`read`/`kill` + `status`/`ls`/`actions`/`diff`/`capture`/`logs`/
`attach`/`run`/`-p`, on CLI **and** MCP; providers claude/codex/gemini/opencode;
hook-based completion + dead-session liveness; structured reads (`actions`/`diff`/
truncation); custom Anthropic-compatible endpoints (DeepSeek/OpenRouter/local) via env.

## Direction — the trust layer (NOT yet built)

The white space the field is ignoring — externally validated (cf. n8n's "AI Trust"
workstream: evals / observability / traces / guardrails / HITL):

- **Typed returns** (`--schema`) — validate + retry until the worker's output fits a shape.
- **Accept / eval gates** (`--accept "<cmd>"`) — a result isn't done until an objective
  check passes; bounded retry with feedback, then escalate.
- **`rctrl trace` / replay** — surface the run record already on disk.
- **Per-worker telemetry** — tokens, context-%, and a *compaction* flag (trust signal).
- **`rctrl keys` / interrupt** — raw key sending (Esc/C-c/menus); already implemented
  internally (`sendKeys`), just not exposed.
- **Self-healing resume** — auto-restart-and-`--resume` a dead worker, built on the
  liveness detection now shipped.

The spine these hang on: an explicit `InvokeSpec` / `Verdict` zod contract — the single
source of truth the CLI, MCP, and YAML all project from.

## Honest limits

The edge is mostly a *craft* moat — neutrality is the only structural one. Durability
depends on actually running drift-detection. Guardrails are only as strong as the
objective verifier ("tests pass" / "matches schema" are airtight; "is it *good*?" needs a
fallible judge — so they raise the floor and catch false-success, they don't guarantee
excellence).
