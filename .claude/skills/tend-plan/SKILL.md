---
name: tend-plan
description: Plan a feature end-to-end - implementation steps with test-first descriptions, optional user-flow steps (if UI), optional security additions (if sensitive), and the test specifications that drive RED in tend-run. Trigger when a feature has slots and checks but no steps.
user-invocable: false
---

# Plan: Slots + Checks -> Implementation Steps (+ User Flow, Security, Test Specs)

**Owns**: `steps[]`, `entry_condition` / `exit_condition`, and the
test-spec content that lives inline in each step's `description`. May add
security-related checks (via `tend_update_feature` merging into `checks[]`).

## Purpose

Turn a feature with defined slots and checks into a complete, executable
plan:

1. **Implementation steps** - typed, ordered steps forming a valid DAG. Each step traces to one or more `checks[]` IDs via `traces_to`. Each agent step with `traces_to` carries a `Test:` block leading its `description` (the failing-test-in-prose).
2. **User-flow steps** - if the feature has user-facing views, add tagged `[action]`/`[assert]`/`[system]` steps. See `references/user-flow.md`.
3. **Security analysis** - if the feature touches auth, payments, PII, or external integrations, add security checks. See `references/security.md`.
4. **Test specifications** - always; the Test block in every step. See `references/test-design.md`.

## What this skill assumes

- Skip planning for polyglots with `data.persona` or `data.opportunity` set. Catalog descriptions don't have steps to plan — their content lives in the structured fields (jobs / outcome_metric / etc.). Route to `/tend position` for authoring instead.
- The feature exists with at least slots, checks, and a smoke decision (output of `/tend brainstorm`).
- Each check the plan will trace to carries `validates_job` (or the feature has no bound personas with jobs). A missing `validates_job` means the failing-test prose has no human-grounded spec — back to `/tend brainstorm` before planning.
- The catalog's bound persona-jobs are resolvable from `catalog.personas[<id>].jobs[<idx>]`. The `validation` text on each job is the spec the step's Test block must mirror.
- The user has agreed in principle on the technical approach. This skill structures the work; it doesn't choose between competing approaches.

## Phase 1: implementation plan

### 1. Read context

For a single-file glance, bash is fine:

```bash
bash docs/tend/features/<id>.tend.html data | jq
```

But the plan needs *cross-file* data — the feature's checks plus the
garden catalog's resolved persona-jobs. That is a computed query, so
use MCP:

```javascript
const ctx = await tend_get_context({ id: "<id>" });
// ctx.feature           — slots, checks, smoke
// ctx.resolved_personas — each persona with archetype + jobs[]
// ctx.dependencies      — resolved dep outputs/artifacts
// ctx.suggested_action  — next-step hint
```

One call returns the feature *and* the persona-jobs each
`validates_job` points at — no separate bash read of the garden.

Check journey context: `journey_phase`, `personas`, `entry_condition`,
`exit_condition`. These inform step ordering, UX polish level, and
verification surfaces. Example: an onboarding-phase feature targeting
non-technical users should prioritize defaults over configuration,
friendly errors over stack traces, and progressive disclosure over
feature density.

Note `integration_level` on each check. Checks marked `integration`,
`e2e`, or `manual` cannot be proven by unit tests in isolation - your
plan must include the steps and test infrastructure that produce real
evidence.

**Resolve `validates_job` via the same `tend_get_context` response.**
For each check with `validates_job` set, split `<persona_id>:<idx>`,
look up the persona in `ctx.resolved_personas`, and pull
`persona.jobs[idx].validation`. That validation text is the spec
source for every step tracing to this check — the `Test:` block's
asserts mirror it. Do *not* re-read `docs/tend/overview.html` from bash to
get this; cross-file resolution is MCP's job.

### 2. Identify scopes

Determine which catalog components are touched. List them explicitly -
this is the plan skeleton.

### 3. Draft steps

For each scope, identify discrete units of work. Add integration steps
where scopes interact.

**Every step must be self-contained.** An agent reading only the step
description must understand exactly what to do and how to verify success.

**The description string IS the contract.** Test + Implement prose is what
the agent reads to execute. Structured fields (`agent_hint`, `verification`,
`outputs`, `artifacts`) supplement for non-prose concerns — model choice,
exit-code shape, what downstream steps consume — but they never replace the
prose. Don't push load-bearing detail into structured fields hoping the agent
will find it; put it in the description.

**Test-first: the description must lead with the test specification.**
Tend's flow runs every agent step with `traces_to` as RED -> IMPL -> GREEN:
write the failing test, then implement until it passes, do not modify the
test. The description has to give the agent enough to write the failing
test before any code is touched. Required structure:

```
Test: <test file path>
Asserts: <see below>
Boundary: <real DB | real HTTP | real browser | pure function | etc.>
Setup: <fixtures, seeded data, env, external stubs (only for genuinely external deps)>
Run: <exact command>

Implement: <how - files to create/modify, logic/algorithm, prior outputs to use>. Do not modify the test file once written.
coverage_files: <repo-relative source files this step will create or modify — omit test files>
```

For each step, append the listed source files to `feature.coverage_files` via `tend_update_feature({ id, changes: { coverage_files: [...existing, ...step_files] } })`. These are intent declarations — run will verify and extend them.

- **Asserts**: must restate the persona's job validation clause for each traced check whose `validates_job` is set. The test is the validation clause made executable, not a paraphrase. If the validation clause is `"Code is running within 60 seconds of opening the laptop"`, the assert is `assert duration_seconds < 60`, not `assert "fast enough"`. Where the validation clause references a measurable outcome (timing, error message text, end-state, count), the assert must reference the same dimension with a comparable threshold.

  Example job-validation → assert mapping:
  - validation: `"Reset button starts a new game without page reload"`
  - asserts: `click("Reset"); expect(boardState).toBeCleared(); expect(navigationEvents).toHaveLength(0)`

The Test block comes first. The Implement block comes second. An agent
reading the description must be able to write the test before reading the
Implement block. If you can't write the Test block - if you don't know
what the test would assert - you don't understand the check well enough
to plan the step. Go back to brainstorm and refine the check's
verification recipe.

**Trace every step to checks.** Each step has a `traces_to: string[]`
listing the check IDs from `checks[]` that the step is responsible for
satisfying. Many-to-many is allowed: one step can prove multiple checks,
and multiple steps can contribute to the same check. Steps that do not
trace to any check are suspicious - either delete them or add the missing
check to the feature (via `/tend change`).

**Required fields per step**: `id`, `title`, `status: "pending"`,
`step_type`, `description` (Test + Implement structure), `traces_to`,
`agent_hint` (`model`, `isolation`, `error_strategy`),
`verification_profile`, `outputs` (if step produces an interface
downstream steps reference).

**Allowed step fields** (the schema is `additionalProperties: false` — see
`schema/polyglot.schema.json` `$defs.step`): `id`, `title`, `description`,
`step_type`, `status`, `dependencies`, `traces_to`, `verification`,
`verification_profile`, `agent_hint`, `outputs`, `artifacts`. Any other
key (e.g. `scope`, `owner_role`) is rejected on first write.

**`step_type` values**: `agent`, `command`, `worktree`, `integration`.
Test-first applies to `agent` and `integration` steps; `command` and
`worktree` steps don't get RED/GREEN wrapping (their exit code is the
test).

**Example step** (self-contained, traces to two checks, test-first):

```json
{
  "id": "i001",
  "step_type": "agent",
  "status": "pending",
  "title": "Implement login endpoint",
  "description": "Test: tests/auth/login.integration.test.ts.\nAsserts: POST /auth/login with seeded user {email: 'a@b.c', password: 'pw'} returns 200 and body matches { token: <string>, expires_at: <ISO> }; same call with wrong password returns 401; missing fields returns 400.\nBoundary: real Postgres test DB; signJWT from step i000 called directly (no mock).\nSetup: one user fixture seeded into test DB with bcrypt-hashed password.\nRun: npm test -- auth/login.integration. Test must FAIL before implementation begins.\n\nImplement: Create POST /auth/login in src/auth/handlers/login.ts. Validate body via src/db/users.ts:findByEmail. Return 200 {token, expires_at} using signJWT from step i000 (src/auth/jwt.ts). Return 401 on bad password, 400 on missing fields. Do not modify the test file once written.",
  "dependencies": ["i000"],
  "traces_to": ["c001", "c002"],
  "outputs": { "login_endpoint": "POST /auth/login", "response_shape": "{ token: string, expires_at: string }" },
  "verification": { "type": "exit_code" },
  "verification_profile": "standard",
  "agent_hint": { "model": "sonnet", "isolation": "worktree", "error_strategy": "fail" }
}
```

**Match step work to check integration_level.** A unit-only test cannot
satisfy an integration check. When a step traces to a check with
`integration_level: integration` or `e2e`, the Test block must specify a
real integration boundary (real DB, real HTTP, real browser, real
filesystem) - not a stub, not a mock-of-the-thing-being-tested. If the
project lacks the test infrastructure (no integration runner, no e2e
harness, no fixture DB), add a setup step before the implementation step.
Do not pretend a unit test proves an integration check.

Additionally: a step's `Test:` asserts must mirror the bound persona-job validation clause (via `check.validates_job`). If the validation clause is abstract enough that no measurable assertion can be derived ("users will love it", "the experience is delightful"), refuse the plan and surface to `/tend position` to refine the job before planning steps.

**Verification profiles** - assign one per step:

| Signal                                                   | Profile     |
|----------------------------------------------------------|-------------|
| Auth, security, payments, encryption, data migration     | `thorough`  |
| Crosses components, 3+ traced checks, new modules         | `standard`  |
| Config, docs, rename, format; `command` steps            | `light`     |
| Default                                                  | `standard`  |

### 4. Validate the DAG

Before writing: all `dependencies` reference a defined step `id`, no
cycles exist, every check has at least one step that traces to it.

After writing the plan, call `tend_validate`. The validator rejects
orphan checks (a check that no step traces to) when steps exist - fix
orphans by adding traces, or by removing the check if it's truly out of
scope (via `/tend change`).

### 4.5. Push back before you write

At the pre-write junction — steps drafted, traces assigned, Test blocks
written — **interrogate the plan before committing it.** Coaching
pressure, not a gate: ask the discriminability questions that apply, push
back with the specific criterion when an answer is weak, let the user
revise OR deliberately accept. Never block the write.

- **Would each step's test FAIL if the implementation were broken?** A
  `Test:` block whose asserts pass on a stub (`expect(x).toBeDefined()`,
  asserting a mock's own return) discriminates nothing. Sharpen the
  asserts to the persona-job validation clause's measurable, or the RED
  phase is theater.
- **Does the assert mirror the bound job's validation clause — or a
  weaker paraphrase?** If the validation says "within 60s on cold start"
  and the assert only checks "returns 200", the plan can't prove the bet.
  Name the gap; tighten the assert to the measured dimension.
- **Is this ONE bet's plan, or has scope crept across several?** If steps
  reach into an adjacent concern with no check tracing to it, that work is
  a different bet on a different feature — cut it (route to `/tend change`).
- **Does any step trace to a check that doesn't discriminate?** If the
  underlying check is vague, the step inherits the vagueness — surface it
  back to `/tend brainstorm` to sharpen the check before planning steps
  for it.

Present each weak answer as a coaching prompt anchored to the criterion
("step i003's assert checks the mock's return, not real DB state — it
won't fail if the query breaks"). The user revises or accepts. Generic
examples only.

### 5. Write plan

```
tend_update_feature({
  id: "<id>",
  changes: {
    steps: [ /* ordered steps with traces_to: ["c001", ...] */ ]
  }
})
```

The MCP write auto-recomputes `progress.implementation` (all steps
`pending` = 0%). Audit is not invalidated because steps are spec-of-truth
only when their `traces_to` or `description` changes - a *new* plan from
nothing doesn't have a prior audit to invalidate. (If the feature was
already at `audit.result === 'pass'`, adding steps to it for new work
would invalidate; refuse and ask the user to confirm via `/tend change`.)

## Phase 2: conditional phases

After writing the implementation plan, evaluate each of the following.

### User-flow steps (if UI)

Does this feature have user-facing views, interactions, or visible state
changes?

If **yes**: document the user flow as `[action]`/`[assert]`/`[system]`
tagged steps inside the same `steps[]` array. The tag goes in the step
title.

See `references/user-flow.md` for the full procedure.

### Security (if sensitive)

Does this feature handle auth, session tokens, payments, PII, file
uploads, or external integrations?

If **yes**: run the security analysis. Output: new checks added to
`checks[]` (each with appropriate `validates`, `integration_level`,
`verification_recipe`), plus any new steps to implement mitigations.

See `references/security.md` for the full procedure.

If sensitive data is found mid-analysis, surface it and ask the user
before continuing.

### Test specifications (always)

Design the test specifications that will be written as failing tests in
tend-run's RED phase. Always run this phase, even if brief. Output:
each step's `description` has a complete `Test:` block.

See `references/test-design.md` for the full procedure.

## Rules

- Plan the EXACT feature as scoped - no scope expansion. Adjacent concerns belong on different features.
- Every step's `traces_to` must reference at least one check ID from `checks[]`. `tend_validate` enforces the inverse: every check must have at least 1 step trace.
- Steps that do not trace to any check are suspicious - either delete them, or surface the missing check and add it to the feature first (via `/tend change`).
- A step traced to an integration/e2e check must include integration-level test work. Unit tests of mocks do not satisfy integration checks. If the test infrastructure is missing, plan a setup step.
- Steps form a DAG - no cycles. Each step belongs to exactly one scope; integration steps bridge exactly two.
- Do not gold-plate - only steps required by checks.
- No implicit context in step descriptions - never write "see feature summary" or "as described above".
- After writing each phase: single-sentence summary unless user requests more.
- **Log decisions**: When a non-obvious choice is made (architecture, library, approach, trade-off), write it to `decisions[]` via `tend_update_feature`. Each entry needs `id`, `at`, `decision`, `rationale`. Include `alternatives_considered` when multiple options were evaluated.

## Done When

- All steps have required fields and form a valid DAG.
- Every step has `traces_to` listing one or more check IDs.
- Every step's `description` leads with a `Test:` block (file path + concrete assertions + boundary + setup + run command) before the `Implement:` block, except for `command` / `worktree` steps where the exit code is the test.
- `tend_validate` passes (no orphan checks).
- Steps tracing to integration/e2e checks include integration-boundary assertions in the Test block, not unit-mock workarounds.
- User-flow steps added if the feature has UI; every check has at least one `[assert]` step tracing to it.
- Security analysis run if relevant; critical/high findings have checks with appropriate `integration_level` and `verification_recipe`.
- Test specifications complete for every step.
- For each step tracing to a check with `validates_job` set, the Test block's Asserts mirror the bound persona-job validation clause measurably (timing, error-text, end-state, count) — no paraphrase, no abstract "good enough" asserts.

## Next move

Close the loop — don't leave the user guessing what comes next.

1. **Compute it.** Call `tend_get_next` (MCP preferred; CLI fallback
   `node dist/bin/tend.js next --json`). It reads on-disk state and
   returns the highest-leverage action with reason codes.
2. **Present it plainly.** State the recommended `action` verbatim and the
   reason in plain words (paraphrase the reason code, don't paste it).
   Example: *"Next: `/tend run auth-login` — the plan is written and the
   DAG is valid, so it's ready to execute."*
3. **Offer to chain — never auto-execute.** Ask before continuing:
   *"Want me to run `/tend run auth-login` now?"* Only proceed on the
   user's yes. If they decline, route to whichever sub-skill matches
   their intent.

After a written plan the usual move is `/tend run`; let `tend_get_next`
confirm rather than assuming.

## See also

- `references/user-flow.md` - tagged step procedure for user-facing flows
- `references/security.md` - actionable security findings -> checks
- `references/test-design.md` - the test spec that lives in each step's Test block
