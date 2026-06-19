---
name: tend-change
description: Apply scope, requirement, or dependency changes to a feature and cascade effects to dependents - including step traces and audit invalidation. Trigger when the user says "actually we need", "change X to Y", or requirements have shifted.
user-invocable: false
---

# Change Request: Update + Cascade

Handle changes to what a feature does, requires, or connects to. Updates
the affected feature and cascades impact assessments - to step traces, to
dependent features, and to audit results that may now be stale.

## What this skill assumes

- The change has been identified — the user has either described it or this skill is invoked from a context where the change is implicit (e.g., a brainstorm or audit run surfacing the need).
- The project state on disk is consistent (no half-applied edits from a previous interrupted change).
- For spine-level changes (renaming a persona, reordering `jobs[]`, editing `opportunity.personas`), the user provides an explicit reindex/rename map when this skill asks for one. The skill refuses silent corruption.
- Audit cascade is the user's responsibility post-change. This skill identifies what needs re-verification; the user runs `/tend audit` to close the loop.

## Why this matters

When checks change, every step that traces to them and every audit
verdict against them becomes potentially invalid. The MCP write's
auto-side-effects handle the easy cases (audit auto-invalidates on
spec-of-truth field changes), but human-judgment cascades to dependent
features are this skill's job. Without explicit handling, you end up
with steps tracing to deleted checks, dependents that silently assume
edges that no longer exist, and audits whose verdicts contradict the
checks they reference.

## Rules

- Always show a before/after diff for every changed field before writing. Confirm with the user before applying.
- Ask confirmation before making any changes to dependent features - the user decides cascade scope.
- Ask the user for clarification when a change is ambiguous - do not guess intent.
- Do not auto-rewrite checks on dependent features - flag them as needing review, never silently change them.
- If a change removes a dependency edge, check whether any dependent feature assumed that edge was satisfied - flag it.
- After all updates, run `tend_validate` and surface any schema errors (especially orphan checks after a step trace is removed).
- If the change would create a dependency cycle, refuse and explain why.
- **Audit auto-invalidation is handled by the MCP write.** Any material change to a check (`description` material change, `validates`, `validates_job`, `method`, `integration_level`, `verification_recipe`), any change to a step's `description` / `traces_to`, or any change to `smoke.cmd` causes the MCP write to clear `audit` and drop `status` from `verified` to `in-progress` in the same call. The skill does not call invalidation explicitly - the side-effect is what makes the cascade durable.
- **The skill does the human-judgment cascade.** MCP handles "this feature's audit is stale". The skill handles "feature X is in feature Y's dependencies, and X just changed its surface area - does Y need to revisit its checks?"

## Workflow

### 1. Identify the change

Clarify what is changing:

- **Slots**: `what` / `why` / `impact` / `fit` / `where` / `how` updated (one-liners; prose changes don't invalidate audit)
- **Checks**: added, removed, modified text, `validates` changed, `integration_level` changed, `method` changed, `verification_recipe` rewritten (any of these invalidates audit)
  - `validates_job` retargeted (job_index changed, persona reassigned, or persona renamed)
- **Plan**: `steps[]` changed (added, removed, reordered, `description` modified, `traces_to` changed - all invalidate audit)
- **Edges**: `dependencies` or `enables` list changed (no audit invalidation, but cascade impact)
- **Smoke**: `smoke.cmd` or `smoke.verify` changed (invalidates audit)
- **Catalog spine changes**: persona renamed / dropped, `persona.jobs[]` reordered or edited, `opportunity.personas` list edited. Each cascades to every feature whose checks point at them via `validates_job` or whose `solves` references the affected opportunity.
- **File rename / removal**: when a source file is renamed or deleted, update `coverage_files` on every feature that claimed it via `tend_update_feature`. Ghost paths (`coverage_path_missing`) block audit from reaching `pass`. Run `tend coverage` after any file-level rename or deletion to find stale claims.
- **Demote to subpage**: a top-level feature is reclassified as a subpage of an existing parent. Follow the sequence in [Step 1a: demote to subpage](#step-1a-demote-to-subpage) instead of the standard update flow.

If the user's description is ambiguous, ask for clarification before
proceeding.

### Step 1a: demote to subpage

When the change kind is "demote to subpage", execute this exact sequence. Do not deviate — each step prevents data loss or broken refs.

**1. Capture full current data.**

```bash
bash docs/tend/features/<old_id>.tend.html data | jq
```

Save the complete parsed `oo-data` object. You will need every field in step 4.

**2. Scan all features for refs to `<old_id>`. Update them BEFORE the delete.**

```bash
for f in docs/tend/features/*.tend.html; do
  bash "$f" data | jq -c '{id, deps: .dependencies, enables: .enables}'
done
```

For each feature that lists `<old_id>` in `dependencies` or `enables`: remove those entries via `tend_update_feature`. The structural parent relationship in the subpage replaces the graph edge — the ref is no longer needed. Confirm this removal with the user before writing.

**3. Create the subpage shell with basic fields only.**

```
tend_create_feature({
  id: "<new_subpage_id>",   // typically <parent_id>.<old_slug> or a fresh slug
  title: "<same title>",
  status: "planned",        // reset; audit evidence from old location is no longer valid
  priority: "<same>",
  what: "<same>",
  why: "<same>",
  // include other non-structural slots as convenient; omit journey_phase, dependencies, enables
})
```

The `tend_create_feature` schema does not accept `parent`. Add it in step 4.

**4. Write full content + parent binding in one `tend_update_feature` call.**

```
tend_update_feature({
  id: "<new_subpage_id>",
  changes: {
    parent: "<parent_id>",           // REQUIRED — makes it a subpage
    // carry over: checks, steps, decisions, audit, narrative, media,
    //             coverage_files, references, smoke, personas, solves, complexity
    // DROP: journey_phase (subpages inherit context from the parent)
    // DROP: dependencies, enables (subpages are internal to the parent)
  }
})
```

Include every content field captured in step 1. If the old feature had `audit.result === "pass"`, carry it over — the audit evidence is still valid; only the structural position changed. If `audit.result` was absent or not `pass`, leave `audit` empty and let `/tend audit` re-evaluate at the new location.

**5. Delete the original top-level feature.**

```
tend_delete_feature("<old_id>")
```

This will succeed only if step 2 already cleared all `dependencies` / `enables` refs. If the tool refuses with a blast-radius error, you missed a ref — fix it and retry.

**6. Validate.**

```
tend_validate()
```

Must return `valid: true` with zero `cross_ref_errors`. If not, do not proceed — diagnose and fix before reporting done.

After completing step 1a, skip to [Step 9: Report](#9-report) with a demotion-specific summary.

---

### 2. Load the feature

```bash
bash docs/tend/features/<id>.tend.html data | jq
```

### 3. Show before/after and confirm

Present the diff clearly:

```
change: auth-login > checks

  before:
    - c001 [what/unit]:        "User can log in with email and password"
    - c002 [what/integration]: "Failed login shows error message"

  after:
    - c001 [what/e2e]:         "User can log in with email, password, or magic link"   (text + integration_level changed)
    - c002 [what/integration]: "Failed login shows error message"                       (unchanged)
    + c003 [what/e2e]:         "Magic link expires after 15 minutes"                    (new)

apply this change? (yes / no)
```

Wait for confirmation before writing.

### 4. Apply the primary change

```
tend_update_feature({
  id: "<id>",
  changes: { /* only the changed fields */ }
})
```

The MCP merge-by-id preserves un-mentioned checks and steps
automatically. Auto-side-effects in this call:

1. **Pre-write validation** - schema, template version, blast-radius (e.g., refuses to delete a check whose ID is in any step's `traces_to`).
2. **Audit invalidation** - if any spec-of-truth field changed, `audit` is cleared and `status` drops from `verified` to `in-progress` unless the same call also writes a fresh `audit.result === 'pass'`.
3. **Progress recompute** - `progress.implementation` and `progress.verification` updated.
4. **Snapshot refresh** - garden's `features_aggregate[<id>]` updated for the touched feature.
5. **Splice** - the new `oo-data` written atomically.

If the call returns an error (e.g., dependency cycle, blast-radius
refusal), surface the error and ask the user how to proceed. Do not pass
`force: true` without explicit user direction.

### 5. Local cascade - step traces

Inside the same feature, the change has local effects:

**Check removed:**

- Find every `steps[].traces_to` that referenced the deleted check ID. Remove those entries from each step's `traces_to`. If a step ends up with empty `traces_to`, surface: "Step `<id>` no longer traces to any check. Add a trace, delete the step, or add the missing check?"
- Audit: any `audit.verdicts[]` entry for the deleted check is auto-removed by the next audit run (since the check no longer exists).

**Check added:**

- Surface: "Check `<new-id>` added. Add `traces_to: ['<new-id>']` to which step(s)?" Don't auto-trace - the user picks.

**Check text or `integration_level` changed:**

- Existing traces stay (the check ID is the same). Existing audit verdicts may no longer hold - auto-cleared by the MCP write side-effect; the next `/tend audit` re-evaluates fresh.
- If `integration_level` got stricter (`unit` -> `integration`, `integration` -> `e2e`, etc.), the check may now require evidence that prior audits did not collect. Flag that explicitly in the cascade summary.

**Step `traces_to` changed:**

- After the merge, run a local check: every check still has at least one step trace. If not, surface the orphan as a blocker - fix it before completing the change.

**Smoke changed:**

- Smoke is part of audit evidence; the auto-side-effect already invalidated audit. Surface that the next `/tend audit` must re-run smoke.

### Step 5.5: Spine cascade

When the change touches the catalog spine, cascade explicitly:

- **Persona renamed (`old_id` → `new_id`)**: scan every feature's checks for `validates_job: "<old_id>:*"`. Each match needs retargeting. The skill rewrites the prefix; the user confirms. No silent renaming.
- **Persona dropped**: every check with `validates_job: "<dropped_id>:*"` is now an orphan. Surface the affected check IDs and refuse the drop until the user reassigns each (or accepts that those checks lose their job anchor — `validates_job` becomes `null`).
- **`persona.jobs[]` reordered or items removed**: this is the silent corruption case. `validates_job: "p1:0"` now points at a *different* Klement Job Story than before, with a different validation clause. The skill REFUSES the reorder unless the user provides an explicit reindex map (`{old: 0, new: 2}` etc.); then it rewrites every `validates_job` accordingly. Without the map, the change is rejected — audits would silently start passing on the wrong spec.
- **`opportunity.personas` edited**: scan every feature whose `solves` includes the affected opportunity. Surface those features for review — the persona alignment claim has shifted.
- **`persona.jobs[idx].validation` text edited**: the spec the check enforces just changed. Invalidate audit on every check whose `validates_job` points at this job (the validation clause is the pass criterion; if its text changes, prior verdicts no longer apply).

### Step 5.7: Re-judge only what you touched

A change edits a slice of the bet, not all of it. The cached `judgments[]` on the feature stay valid for every target the diff didn't touch — re-asking them would re-buy a verdict for text that hasn't changed. So compute **which judgment targets the diff hit**, re-ask ONLY those, and write the refreshed verdicts **in the same `tend_update_feature` call** as the change (the step-4 write). **Untouched targets keep their cached verdicts** — that is the whole point of caching by `judged_sha`.

Map the edit to its targets using the judgment hash-input table — a target is touched iff the change altered any field that target hashes:

| what the change edited | judgment targets it hits |
|---|---|
| `what` and/or `why` | `slots:what+why`, every `persona:<id>` (personas hash the slots), and `feature` (the whole-bet `one_bet`) |
| `impact` | `slots:impact` and `feature` |
| `fit` / `where` / `how` | `feature` only (these feed the whole-bet shape, no per-slot question) |
| `personas[]` set changed | every affected `persona:<id>` and `feature` |
| a `check` added / removed / `description` or `verification_recipe` edited | `check:<check_id>` and `feature` (the bet's check-id set changed) |

Re-ask only the questions whose target appears in the right column, then record the verdict:

- `what_relieves_why` (`slots:what+why`) — does the new WHAT still relieve the pain WHY names, for the bound persona's job?
- `persona_load_bearing` (`persona:<id>`) — does anything in the changed design still depend on this persona, or did the edit make it decoration?
- `impact_measurable` (`slots:impact`) — does the new IMPACT name an observable change a check measures?
- `one_bet` (`feature`) — after the edit, is this still ONE bet, or did the change smuggle a second one in (route the split to a follow-up `/tend change`)?
- `check_discriminates` (`check:<id>`) — would the edited check fail if the unit were broken?

Each entry is `{ question_id, target, verdict, rationale }` with `verdict` one of `pass | push_back | n_a`. A `push_back` is advisory — surface it as a coaching note, never a block.

**Never supply `judged_sha`** — the write side-effect stamps it from the feature's own current text (a caller-supplied value is overwritten). You supply only `question_id` / `target` / `verdict` / `rationale`.

Generic shape (own ids only — never another project's). A change that edited WHAT + WHY and one check re-judges exactly the touched targets; `slots:impact` and any untouched `persona:*` keep their cached verdicts:

```
tend_update_feature({
  id: "auth-login",
  changes: {
    /* ...the changed slots / checks... */
    judgments: [
      { question_id: "what_relieves_why", target: "slots:what+why", verdict: "pass",
        rationale: "New WHAT adds magic-link login; still relieves the same lost-session pain WHY names." },
      { question_id: "one_bet", target: "feature", verdict: "pass",
        rationale: "Magic link is the same login bet, not a second one — no clean split." },
      { question_id: "check_discriminates", target: "check:c001", verdict: "pass",
        rationale: "Edited check asserts the seeded user reaches the dashboard; fails on an empty handler." }
    ]
  }
})
```

### 6. Identify cross-feature cascade effects

Read every feature's polyglot to find references to the changed feature:

```bash
for f in docs/tend/features/*.tend.html; do
  bash "$f" data | jq -c '{id, deps: .dependencies, enables: .enables}'
done
```

Find:

- Features that list the changed feature in their `dependencies`
- Features that the changed feature `enables`
- Features whose `dependencies` array changed (added/removed)

For each potentially affected feature:

- Read it: `bash docs/tend/features/<dep-id>.tend.html data | jq`
- Assess impact: does the change break an assumption, invalidate a step description, or change a requirement they relied on?
- Include `checks[].validates_job` — flag every feature whose check's `validates_job` resolves to a persona or job touched by this change.

### Step 6.5: Narrative terminology sweep

When the change renames or removes a public surface (tool, adapter, field, command, skill, feature) that appears in free-text narrative prose, the schema cascade above is not enough — narratives across polyglots retain the old term until rewritten.

Protocol:

1. `grep -lF "<old-term>" docs/tend/*.tend.html docs/tend/features/*.tend.html` to list affected polyglots.
2. Dispatch parallel `/tend narrate` sub-agents (max 5 concurrent), one per polyglot. Brief each with the old term, the replacement (or "removed — rewrite the section without it"), and the `tend_update_feature` write path.
3. Verify: re-grep the old term. Mentions inside `decisions[]` may be legitimate historical record (judgment call); hits in `narrative` and `slots.*` must reach zero.

If the old term also appears in a persona's `jobs[]` (Klement story), the schema's job-text-mutation guard blocks the catalog write until any `validates_job:` checks anchored to that job are re-pointed to a semantically adjacent job. Include the re-anchor as part of the parallel wave's instructions.

### 7. Cascade with confirmation

For each affected feature, present the impact:

```
cascade: dashboard (depends on auth-login)

  !  Check c001 of auth-login changed text and integration_level (unit -> e2e).
     dashboard's step uf-02 references "user is logged in" - the mechanics
     of being logged in just changed. Steps may need revision.

  proposed: flag for review (no auto-change)
  apply? (yes / no / edit)
```

Only write updates the user confirms. For flagged features, add a brief
note to the dependent's `decisions[]` explaining the cascade - do not
silently change checks or steps. (The dependent's `audit` does not
auto-invalidate from a sibling's check change, by design; the dependent's
own audit was based on its own checks, which are unchanged here.)

### 8. Validate

Call `tend_validate`. Surface any errors. Pay particular attention to
orphan-check errors after a check addition - they mean a step trace is
missing.

Do not leave the feature map in an invalid state.

### 9. Report

```
change-request complete
─────────────────────────────────────────
  changed:    auth-login (c001 text + integration_level; c003 added; smoke updated)
  local:      step i003 traces_to updated; audit auto-invalidated (status: verified -> in-progress)
  cascaded:   dashboard -> flagged for review (decision logged)
  skipped:    profile (no impact)
  validated:  ok; no schema errors

next: /tend audit auth-login (audit needs to re-evaluate after check changes)
─────────────────────────────────────────
```

## Done When

- The primary feature reflects the requested change.
- Step `traces_to` references inside the feature are consistent with the new check list (no orphans, no traces to deleted IDs).
- `audit` was auto-invalidated by the MCP write side-effect on any spec-of-truth change. The feature's `status` dropped from `verified` to `in-progress` if applicable. The skill did not have to call invalidation explicitly.
- All dependent features assessed and either updated (with user confirmation) or flagged for review.
- `tend_validate` passes with no errors.
- Clear summary of what changed, what cascaded locally (auto), what cascaded across features (flagged), and what audit work is now pending.
- Spine refs (`validates_job` on checks, `personas` on opportunities) are consistent post-change: no orphans (every `validates_job` resolves to a live persona-job), no silent reindexing (every reorder of `persona.jobs[]` updated every dependent `validates_job`), no persona-set drift (every feature's `personas[]` aligns with the personas on its `solves` opportunities).
- Only the judgment targets the diff touched were re-judged (per the hash-input table); untouched targets kept their cached verdicts. The refreshed `judgments[]` rode in the same `tend_update_feature` call as the change, and `judged_sha` was never supplied — the side-effect stamped it.

## Next move

Close the loop — don't leave the user guessing what comes next.

1. **Compute it.** Call `tend_get_next` (MCP preferred; CLI fallback
   `node dist/bin/tend.js next --json`). It reads on-disk state and
   returns the highest-leverage action with reason codes.
2. **Present it plainly.** State the recommended `action` verbatim and the
   reason in plain words (paraphrase the reason code, don't paste it). A
   change that touched spec-of-truth auto-invalidated the audit, so the
   move is usually `/tend audit <id>` — *"the checks changed, so the prior
   verdict no longer holds; re-audit before trusting it."*
3. **Offer to chain — never auto-execute.** Ask before continuing:
   *"Want me to run `/tend audit <id>` now?"* Only proceed on the user's
   yes. If the change opened new work (a split feature, a flagged
   dependent), route there instead on their direction.

A change ripples — let `tend_get_next` name the highest-leverage follow-up
(re-audit, re-plan a flagged dependent, or close a freshly-surfaced gap)
rather than assuming the edit is the end of the work.
