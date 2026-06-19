---
name: tend
description: Show next-best action with reasons; route to the right tend-* skill. Trigger when the user mentions features, planning, status, "what should I do", "what's next", "what should I work on", or any `/tend` command.
user-invocable: true
---

# Tend: Next-Action Router

Entry point for all tend-* skills. The primary move is **route the user to their highest-leverage next step** — computed deterministically by `tend next` from on-disk project state, with reasons drawn from the canonical reason-code vocabulary (`src/core/reason-codes.ts`). Status overviews and graph rendering are secondary.

## What this skill assumes

- The project has been initialized with `tend init` (garden polyglot at `docs/tend/overview.html` exists).
- MCP tools are available — preferred path is `mcp__tend__tend_get_next`. CLI fallback is `node dist/bin/tend.js next --json` when MCP is not wired.
- The user wants a routing recommendation, a status read, or to be handed off to a sub-skill.
- Nothing is assumed about the project's spine state — if it's empty, the next-action engine returns a bootstrap action with reason code `unbound_persona` and this skill surfaces that as-is.

## Trigger

- "what should I do?" / "what's next?" / "what should I work on?" / "next action"
- User mentions features, requirements, or planning
- "show status", "what's the progress?"
- "visualize", "show graph", "show dependencies"
- Any `/tend` command without a more specific verb

## Workflow

### 1. Compute the next action

Call the next-action engine. **MCP path is preferred** because it runs in-process and respects the same code the CLI does:

```
mcp__tend__tend_get_next       (preferred)
```

Fallback when MCP is not available:

```bash
node dist/bin/tend.js next --json
```

Both return the same `NextAction` shape:

```json
{
  "action": "/tend audit checkout",
  "feature_id": "checkout",
  "reason_codes": ["stale_evidence"],
  "explanation": "Feature \"checkout\": An audit verdict cites a file whose SHA has changed since the verdict was recorded… Run `/tend audit checkout`.",
  "not_chosen": [
    { "feature_id": "user-login", "reason_codes": ["stale_evidence"], "explanation": "…" },
    { "feature_id": "search-filters", "reason_codes": ["blocked"], "explanation": "…" }
  ]
}
```

If the project has no features yet, the engine returns a bootstrap action with `reason_codes: ["unbound_persona"]` — surface it and stop.

If `tend next` cannot be reached at all (no MCP, no built CLI), say so plainly and suggest `npm run build` or check the MCP wiring. Do not fabricate a recommendation.

### 2. Present the recommendation

Show the user, concisely:

- **Next**: the `action` string verbatim (it's already an imperative)
- **Why**: 1–2 sentences in natural prose, **paraphrased from `REASON_CODES[<code>].long_explanation`** for each cited code. Don't paste the code name as a label; weave the explanation into the sentence so it reads like an advisor speaking, not a JSON dump.
- **Other candidates**: up to 2 `not_chosen` entries, each as one short phrase derived the same way

Format example:

> **Next:** `/tend audit checkout`
>
> The `checkout` feature has a verified audit verdict, but its cited evidence file has changed on disk since the verdict was recorded. Re-audit before trusting the verdict.
>
> Other candidates: `user-login` has the same staleness; `search-filters` is blocked by an unverified dependency.

Paraphrasing rule: read `REASON_CODES[code].long_explanation`, then rewrite it as a sentence anchored to the specific feature id. The codes themselves (`stale_evidence`, `false_done`, `broken_refs`, `cycle_detected`, `mock_only_evidence`, `orphan_check`, `blocked`, `unblocked`, `unbound_persona`, …) are stable strings — useful as identifiers when the user asks "why?" but not the prose the user reads first.

### 3. Hand off

After presenting:

- **User agrees** → reference the recommended slash-command (e.g., `/tend audit checkout`) so the user (or harness) invokes it. Do not directly act — this skill routes, it doesn't audit or plan.
- **User wants context first** → run step 4 (status overview) or list other ready features via `mcp__tend__tend_get_unblocked`.
- **User wants to override** → respect their pick; route them to the sub-skill that matches their intent (see "Sub-skill map" below).

### 4. (Optional) Status overview

If the user asks for status rather than next action:

- One feature's full picture → `mcp__tend__tend_get_context(feature_id)`
- Project ready-queue → `mcp__tend__tend_get_unblocked`
- Project health summary → read `oo-data.health_snapshot` from the garden polyglot (`bash docs/tend/overview.html data | jq '.health_snapshot'`)
- Project validation → `mcp__tend__tend_validate` for the 23 connectedness-invariant warnings and cross-ref errors

Show a compact summary, not a feature-by-feature dump.

### 5. (Optional) Render graph

When the user asks for "visualize", "graph", or "show dependencies", read every feature polyglot's `dependencies` and `enables` and topologically sort:

```bash
for f in docs/tend/features/*.tend.html; do
  bash "$f" data | jq '{id, title, status, dependencies, enables, progress}'
done
```

Group by `journey_phase` if populated. Box-drawing connectors:

- non-last children: `|--`, last child: `\--`
- dependency edges (technical blockers): `-->`
- enables edges (user journey): `~~>`

Glyphs: `v` verified, `!` false-done or blocked, `o` in-progress, `.` planned, `x` failed. 80-col target. No file writes.

## The chain protocol

Tend's skills form a chain, and the chain is **consent-gated at every
hop.** Two halves:

- **Every junction skill ends by offering the next move.** After
  `/tend position`, `/tend brainstorm`, `/tend plan`, `/tend run`,
  `/tend audit`, `/tend narrate`, `/tend change`, and `/tend discover`
  finish their work, each one calls `tend_get_next`, presents the
  recommended action and the reason in plain words, and **offers** to
  chain into the matching skill. It never auto-executes the next skill
  without the user's yes. (Look for the "Next move" section at the end of
  each sub-skill's SKILL.md — that's where this lives.)
- **This router confirms and routes.** When the user lands here — via a
  `/tend` invocation, a "what's next?", or a junction skill handing back —
  the router computes `tend_get_next`, presents the move (step 2 below),
  and routes to the sub-skill on the user's confirmation (step 3). The
  router is the one place the recommendation is *surfaced for a decision*;
  the sub-skills *offer*, the router *confirms*.

The invariant across both halves: **tend leads, the user decides.** No
skill silently chains into the next; the next move is always computed,
always presented in plain words, always gated on consent.

## When NOT to use this skill

This skill is the **routing layer**. It computes, presents, and hands off. It does not author, audit, plan, run, brainstorm, narrate, or change.

If the user's intent is clearly one of the sub-skills, **invoke that skill directly** without going through `/tend`:

- "audit checkout" → `/tend audit` directly
- "plan the search-filters feature" → `/tend plan` directly
- "brainstorm a new feature for X" → `/tend brainstorm` directly
- "narrate the user-login page" → `/tend narrate` directly

`/tend` (this skill) is for "what should I do?" — not for "do this specific thing."

## Sub-skill map

| Command           | Skill           | Purpose                                                                |
|-------------------|-----------------|------------------------------------------------------------------------|
| `/tend position`  | tend-position   | ICPs + Klement Job Stories + `opportunity.personas[]` — the spine downstream skills read |
| `/tend brainstorm`| tend-brainstorm | New feature from idea or import; slots + checks (with `validates_job`) + smoke |
| `/tend discover`  | tend-discover   | Map an existing codebase into features (one-time bootstrap)            |
| `/tend plan`      | tend-plan       | Steps with test-first descriptions; asserts mirror persona-job validation clauses |
| `/tend narrate`   | tend-narrate    | Write the article-style narrative + inline SVG diagrams                |
| `/tend run`       | tend-run        | Generate execution plan via adapter, then `bash <file> run`            |
| `/tend audit`     | tend-audit      | Verify checks against job validation clauses; the only writer of `audit.result` and `status=verified` |
| `/tend change`    | tend-change     | Apply a change and cascade impact (incl. `validates_job` retargets, persona reindex maps) |

The next-action engine emits `action` strings that map 1:1 to this table — when you see `/tend audit <id>` in the recommendation, that's the audit skill on that feature id.

## Reason codes — a note on prose

Reason codes are stable snake_case strings drawn from `src/core/reason-codes.ts` (e.g., `stale_evidence`, `false_done`, `broken_refs`, `cycle_detected`, `orphan_check`, `mock_only_evidence`, `blocked`, `unbound_persona`). When citing them in prose, **paraphrase from the `long_explanation` field** rather than pasting the code name verbatim. The code names are identifiers for agents and validators; the long explanations are written as complete sentences so they read naturally in advisor voice.

Full table with categories, severities, and default action hints lives in `references/reason-codes.md` (T2.7 owns that artifact). Source of truth is always `src/core/reason-codes.ts`.

## Rules

- The primary move is **call `tend next`** (MCP preferred, CLI fallback) and present its output. Don't reinvent the algorithm.
- Reasons are paraphrased from `REASON_CODES.long_explanation`; never invent reasons or relabel codes.
- Routing only — never mutate feature state. Writes belong to sub-skills via MCP.
- Two progress numbers per feature when status is shown (`implementation%`, `verification%`). `implementation === 100` alone never reads as done.
- All reads go through the polyglot's `data` verb piped to jq, or through MCP discovery tools (`tend_get_next`, `tend_get_unblocked`, `tend_get_gaps`, `tend_get_context`, `tend_validate`). Never parse `.tend.html` files as text.
- Graph rendering is opt-in: only when explicitly requested.
- Output target: 80 columns.

## See also

- `references/schema.md` — the data shape every sub-skill writes against.
- `src/core/reason-codes.ts` — canonical reason-code vocabulary.
- `src/core/next-action.ts` — the deterministic engine behind `tend next`.
