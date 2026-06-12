---
name: tend-audit
description: Verify a feature's checks against real evidence. Owns `audit.verdicts`, runs `smoke.cmd` if defined, records drift, and is the only path to `status = "verified"`. Trigger after `/tend run` completes, after `/tend discover` for a mature codebase, or anytime an honest read on whether a feature actually works is needed.
user-invocable: false
---

# Audit: Verify Checks

Verify that existing code satisfies a feature's documented checks. Use
after `/tend discover` on mature codebases, after `/tend run` completes,
or anytime you need an honest read on whether a feature actually works.
Owns the `audit` section of feature polyglots and is the only writer of
`status = "verified"`.

## What this skill assumes

- Skip auditing polyglots with `data.persona` or `data.opportunity` set. Catalog descriptions don't have checks or smoke commands — they aren't verified as bets.
- The feature has checks with `verification_recipe` (output of `/tend brainstorm`).
- For checks with `validates_job` set, the bound persona-job's `validation` clause is the pass criterion — the test must assert against it, not just the recipe.
- The implementation exists on disk and is testable (steps are at least `in-progress`; ideally `done`).
- This skill is the ONLY writer of `audit.result` and the gate to `status: "verified"`. No other skill sets these fields.

## Why this skill matters

Run marks steps `done` when the agent reports completion. That answers
"did the code get written?" - not "does it satisfy the check?" Audit
closes that gap. Without an audit run, a feature can sit at
`progress.implementation === 100` with `progress.verification === 0` and
nobody notices the lie.

## What the audit actually asks

A green badge has to mean three things, not one. For every check, the audit answers:

1. **Built?** — the code the check claims is done is *actually* done. No `TODO` / `FIXME` / `XXX` / `HACK`, no `throw 'not implemented'` / `NotImplementedError`, no stub body returning a hardcoded placeholder, no large commented-out blocks, no mock standing in for real behaviour on the production path. A `// TODO` in code labelled "done" is a contradiction this skill exists to catch — **flag it whether or not the project tolerates TODOs while building.** That tolerance is the *builder's* policy; surfacing the gap is the *auditor's* duty, and it is not optional.
2. **Proven?** — a real test exists, exercises the real unit (not mocks), runs green *this audit*, **discriminates** (fails when you break the unit — see negative control), and asserts the *measurable* outcome (the persona-job validation clause), not a trivial surface like `expect(x).toBeDefined()`.
3. **Built well?** — the implementation and test meet the project's quality bar (its `CLAUDE.md` / referenced rubric) plus the universal engineering floor in the Quality rules.

**Completeness and proof failures (1, 2) pull the verdict down — they mean the bet isn't proven.** Quality deviations on otherwise-correct, discriminating code (3) are recorded as findings so the loop fixes them, without lying about whether the bet holds.

## Fits the whole

| Layer            | Role                                                                 |
|------------------|----------------------------------------------------------------------|
| MCP tools        | `tend_update_feature` (writes `audit`); `tend_get_context` (reads — feature + resolved personas including bound job text) |
| Polyglot         | `bash <file>.tend.html data | jq` for single-file scans; `bash <file>.tend.html smoke` to run the smoke command |
| Reads            | `checks[]` (with `integration_level`, `verification_recipe`), `steps[]`, `smoke.cmd`, and per-check **persona-job validation clauses**. Resolving `validates_job` → garden's `catalog.personas[<id>].jobs[<idx>].validation` is a cross-file lookup, so use `tend_get_context` (it returns `resolved_personas` already), not a second bash read of the garden polyglot |
| Writes           | `audit.ran_at`, `audit.result`, `audit.verdicts[]`, `audit.drift[]`, `smoke.last_run`, `smoke.last_result`, and `status = "verified"` in the same call when justified |
| Does not own     | `steps[]`, `checks[]` definitions (only their verdicts), `progress` (auto-recomputed) |

**Persona-job validation clauses** — via each check's `validates_job` → `catalog.personas[<id>].jobs[<idx>].validation`. That validation text is the *spec* the check must satisfy. The `verification_recipe` is the test sketch; the job validation is the pass criterion. Both must align — when they diverge, the validation clause wins.

## Ownership

- **`audit.verdicts[]` and `audit.result` are owned by `tend-audit`.** Other skills must not write these fields. The schema enums (`verdict: pass | partial | fail`, `result: pass | partial | fail`) are the floor; this skill is the source.
- **`status = "verified"` is reachable only through this skill.** `tend_update_feature` rejects `status: "verified"` unless `audit.result === "pass"` is on disk or in the same call. `tend-audit` writes the verdicts and the verified status together when evidence supports it.

## Rules

### Evidence rules

- Evidence must be specific: file path and line number (e.g., `src/auth/login.ts:42`), or command + output, or screenshot/DOM snapshot. "Similar code exists" does not count.
- For each check, mark exactly one of: `pass` (clear evidence), `partial` (some evidence, gaps remain), `fail` (no evidence or contradictory evidence).
- **Test must exist and exercise the unit under test.** For each check (excluding `manual` integration_level), confirm a test file exists that (a) the test framework picks up (named per project conventions, in the test directory), (b) imports and calls the unit the check is about - not exclusively through mocks, (c) currently passes when run. If the test file doesn't exist, check is `fail`. If the test exists but mocks the unit under test, check is `partial`. If the test exists, exercises the real unit, but currently fails, check is `partial` (regression).
- **Proof of execution, not existence.** A `pass` verdict requires that you *ran* the test in this audit and watched it pass — not that you read the source and judged it correct. The verdict's `evidence_path` must carry the exact run command and the observed result line (e.g. `tests/auth/login.test.ts — ran 'npx vitest run tests/auth/login.test.ts' → 4 passed`). A bare `file:line` citation proves the code exists, not that it works; cite-only-path evidence caps the verdict at `partial`. An agent's self-report of "it passes" with no captured result line is not evidence — paste the result.
- **Mocks of the unit under test are zero evidence.** If the only test for a check is a test where `vi.fn()` (or any mock) returns the value the check describes, the test proves nothing - it proves the mock returns what you told it to. Mark `partial` and require a real test before any future audit can mark it `pass`.
- **Completeness scan — the code claimed done must actually be done.** Read the *implementation* the check cites, not just its test. Any `TODO` / `FIXME` / `XXX` / `HACK`, `throw new Error('not implemented')` / `NotImplementedError`, empty or stub body returning a hardcoded placeholder, large blocks of commented-out logic, or a mock standing in for real behaviour on the production path means the thing is not built. Record it and downgrade — `partial` if the feature is scaffolded but incomplete, `fail` if the core behaviour is absent. Flag it regardless of whether the project tolerates TODOs while building; that policy is the builder's, surfacing the gap is yours.
- **Negative control — the test must discriminate.** Before recording any `pass`, run the atomic negative-control helper against a throwaway worktree — **never hand-edit the live source file**:

  ```
  npx tend-cli negctrl \
    --file <repo-relative-path>             \
    --find '<exact load-bearing substring>' \
    --replace '<broken replacement>'        \
    --test '<test command>'
  ```

  `--find` must match the target file **exactly once** (0 or >1 matches → exit 2, operator error — refine the substring). Replacement is literal string, not regex.

  Exit codes and verdicts:
  - Exit 0 → green on clean code, **failed** against the broken copy → stdout: `DISCRIMINATES` → real evidence, may record `pass`.
  - Exit 1 → green on clean code, still **passed** against the broken copy → stdout: `DOES NOT DISCRIMINATE` → the test proves nothing → cap verdict at `partial` with note `test does not discriminate`.
  - Exit 2 → **invalid baseline** (the cited test is not green on unmodified code — red baseline, bogus command, or env mismatch), indeterminate run, or usage error (bad args, ambiguous find, git failure). A negative control cannot run on a non-green baseline: fix the test (or the invocation), and treat the check as unproven (`partial`) until it is genuinely green. The helper runs the cited test on the clean copy **first** and refuses to render a verdict unless that baseline passes — so a command that fails on everything can never masquerade as `DISCRIMINATES`.

  The helper creates a detached worktree at HEAD in `/tmp`, mirrors working-state changes via `git diff HEAD | git apply`, applies the mutation only inside that copy, runs the test with cwd set to the worktree, then **unconditionally tears down in `finally`** — the live working tree is never touched and no worktrees are left behind on success, failure, or crash.

  This is the one rule a fake cannot survive: created-file-plus-weak-test cannot be made to fail. Skip only for `manual` checks and pure existence/config checks that have no unit to break — say so in the verdict.
- **Match evidence to `integration_level`.** If the check is `integration` or `e2e` and the only evidence is a unit test (whether or not it mocks), mark `partial`. Real-stack evidence is required for non-unit checks. For `manual`, record human-verification evidence (sign-off, screenshot, recording) - do not auto-pass.
- **Read the bound persona-job validation clause as the pass criterion.** Mark `partial` when the test passes its `verification_recipe` but does not assert the job validation clause measurably. Example: recipe says "POST returns 200", job validation says "completes in <60s on cold start" — these are different bars. The test must assert against the validation clause's measurable component (timing, error-message text, end-state, count) for the verdict to be `pass`. A check with `validates_job` set but no validation-clause assertion in its test is `partial` no matter how green the test runs.
- **A verdict downgrade is the audit succeeding.** Pass→partial or partial→fail means the cited evidence no longer supports the claim — tests changed, code drifted, an invariant broke. That signal is the whole point of running the audit. Never refresh `evidence_sha` just to silence a `stale-evidence` warning. If the claim is broken, write the downgrade honestly; the resulting gap-card routes the follow-up work.
- **Trivial `verification_recipe` caps the verdict at `partial`.** Before recording any pass, inspect the check's `verification_recipe`. If it is under ~20 characters or matches a boilerplate phrase (`"check manually"`, `"tests pass"`, `"it works"`, `"run tests"`, `"manually"`, `"works"`, or any similar non-specific phrase), the recipe is too vague to constitute an evidence bar — the audit cannot confirm what "passing" means. Cap the verdict at `partial`, note `trivial recipe — author a concrete recipe via /tend brainstorm`, and do not record `pass` no matter how green the negctrl run is. The fix is to write a real recipe (specific command, expected output, measurable assertion) via `/tend brainstorm`, not to stretch the vague phrase to meet the threshold.
- **Cite stable artifacts — never hash a living file.** A verdict's `evidence_path` must point at an artifact whose content is stable between writes: a source file, a test file, a committed fixture. **Never cite the garden polyglot (`docs/tend/overview.html`) or any other file that mutates on every write** — its SHA changes the instant the next feature is written, so a verdict hashing it goes `stale-evidence` immediately and forever, generating a re-audit treadmill that proves nothing. If the behavior under audit is produced by such a file, cite the *stable code that produces it* (e.g. the side-effect function in `src/core/`, the renderer partial), not the mutable artifact it writes into. For a `manual` check (visual review, sign-off, observed behavior with no unit to break), record the observation as prose in the verdict notes and cite the stable code that produces the behavior — do not fabricate a hashable evidence path just to fill the field.

### Quality rules

The audit also judges whether the implementation and test are *built well*, not just present. Two layers:

- **Project rubric (pluggable).** Read the project's `CLAUDE.md` (or a referenced quality doc) and hold the code to *its* rules — the project supplies its own bar (e.g. strict referential transparency, naming conventions, dependency boundaries).
- **Universal engineering floor (always).** On top of the project's rules, every codebase is held to these — they are recognised best practice, not preference:
  - side-effects (I/O, network, fs) separated from business logic, not interleaved;
  - dependencies passed in, not reached for via globals / singletons;
  - functions handle their declared inputs without hidden throws on valid input;
  - no needless duplication of logic that already exists;
  - the error paths and edge cases the check implies are actually handled;
  - native language/framework idioms over hand-rolled reinvention;
  - the smallest change that does the job — no dead scaffolding, no speculative generality.

Record violations as `audit.drift` entries (`action: investigate | document | remove`). **Deviations on otherwise-correct, discriminating code are findings, not verdict failures** — the bet is proven, the code needs polish, the loop routes it. **But the egregious kind that means the thing isn't really built — stub, dead code, mock-theatre, a test that doesn't discriminate — downgrade the verdict.**

### Process rules

- If `checks[]` is empty or missing, stop and ask the user to define checks via `/tend brainstorm` before auditing.
- Drift findings: code that exists implementing feature-like behavior but is undocumented. Each finding suggests an action - document it, remove it, or investigate further.
- Do not modify checks themselves - only record verdicts against them. Use `/tend change` if a check needs editing.
- Read the full intent before verifying: the six slots (the claims), the **narrative** (how it's meant to work), and the **decisions** (why it's shaped this way). `tend_get_context` returns all of it. The code is answerable to all three — not only the checks. Audit against the intent, not just the recipe.

## Workflow

### 0. Read drift_verdict

Before auditing anything, read `drift_verdict` from `tend validate`. If it's `stale-evidence` (an audit verdict's `evidence_sha` drifted since it was recorded) or `narrative-cite-stale` (a narrative cites a file that no longer exists), the existing audit is no longer trustworthy — re-audit the feature named in `recommended_next_command` before doing anything else. If it's `broken-refs`, fix the graph first; auditing against a broken cross-ref wastes work.

When the `audit_evidence_stale` warnings list spans many features (common after `tend sync` or a large refactor), do not act on `recommended_next_command` alone — extract the full set, group by feature id, and dispatch parallel sub-agents (max 5 concurrent) each running this skill for one feature. The MCP write side-effects refresh `evidence_sha` automatically when each verdict is re-recorded; the only judgment is whether each claim still holds.

### 1. Load the feature

```bash
bash docs/tend/features/<id>.tend.html data | jq
```

Or via MCP for resolved deps:

```
tend_get_context({ id: "<id>" })
```

Confirm `checks[]` is non-empty. Note `integration_level` per check
(defaults to `unit` if absent), and whether `smoke.cmd` is defined.

### 2. Search for evidence per check

For each check, collect evidence in priority order:

1. **Tests that exercise the real code** - look at `*.test.*`, `*.spec.*`, `tests/`, integration test directories. The strongest evidence is a passing test that calls real implementation code with realistic inputs.
2. **Implementation files** - find where the check's behavior is implemented. File:line citation.
3. **Configuration / data** - for checks about defaults, schemas, etc., point to the config or data file.
4. **Smoke test output** - captured in step 4 below.
5. **Manual verification** - for `manual` integration_level: sign-off, screenshot, recording, observed behavior the user reports.

For each check's evidence, evaluate:

- Does the test (if any) mock the primary system the check is about? If yes - flag as zero-evidence and downgrade.
- Does the check's `integration_level` match the test level of the evidence? If check is `integration` and only unit tests exist, mark `partial`.
- For `entry_condition` / `exit_condition` features: confirm the code enforces the entry condition (route guard, middleware, precondition assertion) and reaches the exit condition (success branch produces the declared state).
- For each check, resolve `validates_job` (if set) to the persona-job validation clause (`personas[id].jobs[idx].validation`). The strongest evidence is a test that asserts on the validation clause's measurable component. A test that only asserts the recipe's surface ("returns 200") while the validation demands more ("within 60s") is documented as `partial` in the verdict notes.
- **Built? (completeness)** — read the cited *implementation*. Flag + downgrade on any TODO/FIXME, `not implemented` throw, stub/placeholder body, or production-path mock (Completeness-scan rule).
- **Discriminates? (negative control)** — before recording `pass`, run `npx tend-cli negctrl` (Negative-control rule). Exit 0 → `DISCRIMINATES` → may record `pass`. Exit 1 → `DOES NOT DISCRIMINATE` → cap at `partial`. Never hand-edit the live source file.
- **Built well? (quality)** — assess the implementation + test against the project rubric + the universal floor (Quality rules); record deviations as drift, downgrade the egregious "not really built" ones.

### 3. Record per-check verdicts

Build the `audit.verdicts[]` array. Each entry:

```json
{
  "check_id": "<check-id>",
  "verdict": "pass | partial | fail",
  "evidence_path": "src/auth/login.ts:42; tests/auth/login.integration.test.ts:18 (real DB, no mocks)",
  "validates_job_satisfied": true
}
```

Required fields: `check_id`, `verdict`. For `pass`, `evidence_path` MUST
include the run command and the observed result line (proof of execution) —
not a bare file path. For `partial`, cite what exists and what is missing
(unrun test, mocked unit, unit-only evidence for an integration check).
`fail` may have an empty evidence note (or a note about where evidence
should be).

`validates_job_satisfied` answers whether the test actually asserts the persona-job's validation clause (not just the verification recipe). `null` when the check has no `validates_job` (feature has no bound personas with jobs); `true` when the test mirrors the validation clause's measurable; `false` when the test passes a weaker bar.

### 4. Run the smoke test (if defined)

If `smoke.cmd` is set, run it via the polyglot:

```bash
bash docs/tend/features/<id>.tend.html smoke
```

1. Capture stdout/stderr and exit code.
2. If `smoke.verify` is set, check the output matches (regex/substring).
3. Result: `pass` if exit 0 and (no verify OR verify matched), `fail` otherwise.
4. Record under `smoke.last_run` (ISO timestamp) and `smoke.last_result`. Add a summary line to evidence for checks the smoke exercises.
5. **Smoke fail -> `audit.result` cannot be `pass`.** Demote `audit.result` to at most `partial`. The feature does not transition to verified.

### 5. Detect drift

Scan code related to the feature's scope for behavior not captured in
any check. For each drift finding:

```json
{ "file": "src/auth/legacy-token.ts", "finding": "...", "action": "document | remove | investigate" }
```

### 6. Audit step quality (informational)

For each `steps[]` entry, flag:

- Description shorter than 50 characters or missing.
- Empty or missing `traces_to`.
- Step description references "see feature summary" or "as described above".
- Agent steps with no `agent_hint`.
- Steps producing an interface that other steps reference but no `outputs` declared.
- **Missing test specification**: agent steps with `traces_to` whose `description` does not lead with a `Test:` block (file path, asserts, run command). The plan skill is supposed to require this; missing it means the plan slipped or predates test-first.
- **Test file referenced but absent**: when the description does name a test file, confirm the file exists in the repo. Missing file is a flag (informational; the per-check evidence rules above handle the substantive verdict).

These do not affect `audit.result`. They surface in the report so the
planner can fix them.

### 7. Cross-check coverage_files

Run `tend_validate` and treat any `coverage_path_missing` error as an audit verdict failure — a ghost path in `coverage_files[]` is missing evidence. Also run `tend coverage` (CLI) and surface the unclaimed file count in verdict notes (informational; does not block a `pass` verdict on its own).

### 8. Compute audit.result

- `pass`: every check has `verdict: pass`. Smoke (if defined) passed. No `coverage_path_missing` errors.
- `partial`: at least one check is `partial`, none are `fail`, smoke (if defined) passed.
- `fail`: any check is `fail`, OR smoke failed, OR any `coverage_path_missing` error exists.

### 8.5. Re-judge the verification questions

Audit doesn't only check evidence — it re-asks the two **verification-relevant** semantic questions and records refreshed `judgments[]` **in the same `tend_update_feature` call** as the audit verdicts (one write, not two). These are advisory and never gate the audit; they cap *confidence in the bet* alongside the evidence verdict.

Two questions apply at audit:

| `question_id` | the question | `target` |
|---|---|---|
| `check_discriminates` | "Would this check FAIL if the unit were broken, or does it pass on anything?" | `check:<check_id>` |
| `impact_measurable` | "Does IMPACT name a real, observable change — and does a check measure that quantity?" | `slots:impact` |

**The negctrl-skip rule for `check_discriminates`.** A check whose evidence already survived a **discriminating negctrl run** (`DISCRIMINATES`, exit 0, from step 2) is mechanically proven to discriminate — the semantic question is redundant and re-asking it double-surfaces the same concern. **Skip `check_discriminates` for any check with a green discriminating negctrl.** Record ONE feature-level `n_a` documenting the skip (not one per proven check), rationale: `"negctrl proves discrimination mechanically; semantic re-judgment skipped for negctrl-proven checks."` Re-ask `check_discriminates` (writing `pass` / `push_back`) only for checks WITHOUT a discriminating negctrl — `manual` checks, pure existence/config checks, or any check the negctrl couldn't run on.

**`impact_measurable`** is re-asked whenever IMPACT is filled — a green test can still measure the wrong quantity. `pass` when a check measures the observable IMPACT names; `push_back` when IMPACT is a wish ("faster", "better") with no check measuring it.

**push_back is advisory — it NEVER blocks the audit result.** A `push_back` here caps confidence in the bet even when every check passes against evidence (the checks prove the code; the judgment flags a semantic gap the evidence audit is blind to). It does not downgrade `audit.result`, does not stop the `status: "verified"` transition, and does not move the health verdict — it lands in the refinement backlog. Optionally note the gap in `audit.drift` (`action: investigate`) so the loop sees it; the judgment record is the durable home.

**Never supply `judged_sha`** — the write side-effect stamps it from the feature's own current text (a caller-supplied value is overwritten). You supply only `question_id` / `target` / `verdict` / `rationale`.

Generic shape (own ids only — never another project's), carried in the step-9 write:

```
judgments: [
  { question_id: "check_discriminates", target: "check:c001", verdict: "n_a",
    rationale: "negctrl proves discrimination mechanically; semantic re-judgment skipped for negctrl-proven checks." },
  { question_id: "impact_measurable", target: "slots:impact", verdict: "push_back",
    rationale: "IMPACT says 'faster sign-in' with no number; no check measures latency. Code passes, the impact claim is unmeasured." }
]
```

### 9. Write audit and (when justified) transition to verified

Call `tend_update_feature`. Pass `audit` (verdicts, result, ran_at, drift)
and the refreshed `judgments[]` (step 8.5) **in the same call**.
When `audit.result === "pass"` AND every check has `verdict: pass` AND
smoke (if defined) passed, also pass `status: "verified"` in the same
call - the verified-status gate accepts it because `audit.result === 'pass'`
is in the same payload.

```
tend_update_feature({
  id: "<id>",
  changes: {
    audit: {
      ran_at: "<ISO timestamp>",
      result: "pass",
      verdicts: [/* per-check verdicts */],
      drift: [/* drift findings */]
    },
    judgments: [/* step 8.5 — check_discriminates (non-negctrl checks) + impact_measurable */],
    status: "verified"
  }
})
```

If `audit.result` is `partial` or `fail`, do not include
`status: "verified"`. Leave the feature wherever it was (likely
`in-progress`).

If checks changed since the last audit (the prior `audit` was
auto-cleared by the change), re-run the audit fresh - do not preserve
old verdicts.

### 10. Read recomputed progress

The MCP write recomputes `progress.verification` automatically based on
the new verdicts. Read it back if you need to report:

```bash
bash docs/tend/features/<id>.tend.html data | jq '.progress'
```

### 11. Report

```
audit: <feature-id>  result: pass | partial | fail
─────────────────────────────────────────────────
v  <N> pass
!  <N> partial
x  <N> fail

smoke test: pass | fail | not defined
  command: <command>
  output: <relevant lines>

drift: <N> findings
  src/.../old-handler.ts - undocumented; action: investigate

verification: <N>%   implementation: <N>%

<if all pass>
Feature transitioned to status=verified.

<if partial/fail>
Feature remains <previous status>. Address: <check-ids> before next audit.
```

## Done When

- Every check has a `verdict` and (where verdict is `pass` or `partial`) specific evidence.
- Every `pass` verdict's `evidence_path` carries proof of execution — the run command and the observed result line — not a bare file path. Verdicts backed only by reading source, or by a path citation with no captured run result, were capped at `partial`.
- Mocks-of-unit-under-test were not counted as evidence. Checks whose only evidence was a mocked test are marked `partial` with a note.
- Each `pass` verdict survived a **negative control** — `npx tend-cli negctrl` was run against a throwaway worktree; the live source was never mutated. `DISCRIMINATES` (exit 0) was confirmed before recording `pass`; `DOES NOT DISCRIMINATE` (exit 1) capped the verdict at `partial`.
- The cited implementation was **scanned for completeness**; any TODO / stub / `not implemented` / production-path mock was flagged and the verdict downgraded.
- Implementation + test were assessed against the project's quality rubric + the universal engineering floor; deviations recorded as `audit.drift`, with the "not really built" kind downgrading the verdict.
- Check `integration_level` was respected: integration/e2e checks marked `pass` only when real-stack evidence existed.
- Smoke ran if defined; `smoke.last_run` / `smoke.last_result` recorded; smoke failure prevented `audit.result = "pass"`.
- Drift findings recorded with actionable suggestions.
- `audit` section written via `tend_update_feature`.
- `status = "verified"` set in the same call iff `audit.result === "pass"` and every check has `verdict: pass`.
- Progress recomputed (auto-side-effect of the write).
- A summary report is shown to the user that distinguishes verified from implemented-but-unverified.
- For each check with `validates_job` set, the verdict was evaluated against the bound persona-job validation clause (`personas[id].jobs[idx].validation`), not just `verification_recipe`. Mismatches between validation clause and recipe were resolved in favor of the validation clause and surfaced as `partial` verdicts where the test asserts the weaker bar.
- The verification questions were re-judged in the same write: `impact_measurable` whenever IMPACT is filled, and `check_discriminates` only for checks WITHOUT a discriminating negctrl (negctrl-proven checks recorded ONE feature-level `n_a` documenting the skip). `judged_sha` was never supplied — the side-effect stamped it. Any `push_back` was advisory: it did not block the audit result or the verified transition.

## Next move

Close the loop — don't leave the user guessing what comes next.

1. **Compute it.** Call `tend_get_next` (MCP preferred; CLI fallback
   `node dist/bin/tend.js next --json`). It reads on-disk state and
   returns the highest-leverage action with reason codes.
2. **Present it plainly.** State the recommended `action` verbatim and the
   reason in plain words (paraphrase the reason code, don't paste it).
   The move depends on the verdict: a `pass` usually frees a blocked
   dependent (*"`dashboard` was waiting on this — it's unblocked now"*); a
   `partial` / `fail` routes to `/tend change` or `/tend run` to close the
   named gap; a clean board may point at `/tend narrate` to write the
   story.
3. **Offer to chain — never auto-execute.** Ask before continuing:
   *"Want me to run `/tend run dashboard` now?"* Only proceed on the
   user's yes. If they decline, route to whichever sub-skill matches their
   intent.

After an audit, let `tend_get_next` pick the next leverage point rather
than assuming the work is finished — a green verdict often unblocks the
real next feature.
