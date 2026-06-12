# Test-Specification Procedure

**Owns**: the `Test:` block of every step's `description` in
`feature.steps[]`. May also propose verification recipe refinements
upstream to `tend-brainstorm` if a check's recipe is too vague to write
a test from.

## Purpose

Author the test specifications that will be run as failing tests in
tend-run's RED phase. Tend's flow is test-first universally: every step
writes a failing test before any implementation. This phase produces the
specs concrete enough that an agent (or human) can write the failing
test from them.

This is **not** a "design tests as descriptions" exercise. It's writing
the test the agent will need to write - file path, what it asserts, the
data and boundaries involved - before the implementation step is
finalized.

## Rules

- **Test specs feed step descriptions.** For each step in `feature.steps[]`, the spec produced here goes into the step's `description` as the leading `Test:` block. The reference below specifies what's in the block; tend-plan injects it.
- **One spec per step, covering its `traces_to` checks.** A step traces to one or more checks (from brainstorm). The Test block must assert what those checks require. If multiple checks are covered, the test asserts each.
- **Test level must match check `integration_level`.** A unit test cannot prove an `integration` or `e2e` check. If a step's `traces_to` includes an integration-level check, the spec must call for a real boundary (real DB, real HTTP, real queue). If `e2e`, real runtime (browser, server, filesystem, real device). If `manual`, the "test" becomes a written verification checklist a human walks. Mismatched level is a red flag.
- **Mocking the unit under test is zero evidence.** If the check is "the JWT signer produces tokens that include exp claims" and the spec calls for `vi.fn()` returning `{exp: ...}` from `signJWT`, that's not a test. Use mocks for *external* dependencies (clipboard, network, third-party APIs), never for the function the check is about.
- **Specs must be concrete enough to write the test from.** Required: file path, the inputs/setup, the assertion(s), the run command. Not required: the test code itself - the RED task in run produces that.
- **`[assert]` steps in user-flow are e2e tests by definition** - they observe user-visible state. Derive specs directly. Checks covered solely by `[assert]` steps default to `integration_level: e2e`.
- **Plan setup steps when test infrastructure is missing.** If the project has no integration test runner, no fixture DB, or no e2e harness and you have non-unit checks, the test specs imply work that doesn't exist yet. Add a setup step before the implementation step. Don't downgrade the test level to fit missing infra.
- **Happy path first** - write specs for happy path before edge cases, edge cases before error cases. Within a step's spec, the primary assertion comes first.
- **Flag ambiguity** - if a check is untestable as written, say so. The check's `verification_recipe` is the source of truth; if it's not concrete enough, refine the recipe via `/tend change` (or back to `/tend brainstorm`) before writing the step.

## Workflow

### 1. Check prerequisites

Feature must have:

- `checks[]` non-empty, every check with a `verification_recipe`.
- `steps[]` drafted (the plan phase produces these).

If recipes are missing, stop and redirect to `/tend brainstorm`.

### 2. For each step, author the Test spec

For every step in `feature.steps[]` that has `traces_to` and is
`step_type: agent | integration`, produce a Test spec covering its
traced checks:

```
Test: <test file path>
Asserts: <concrete inputs and expected outputs/state - derived from each traced check's verification_recipe>
Boundary: <real DB | real HTTP | real browser | pure function | etc., matching the highest integration_level among traced checks>
Setup: <fixtures, seeded data, environment, external stubs (only for genuinely external deps)>
Run: <exact command - npm test -- <pattern>, pytest <path>, etc.>
```

The Test spec lives inline in the step's `description` as the leading
block:

```
Test: tests/auth/login.integration.test.ts
Asserts: POST /auth/login with seeded user {email: 'a@b.c', pw: 'pw'} returns 200 + body { token: <string>, expires_at: <ISO> }; wrong password returns 401; missing fields returns 400.
Boundary: real Postgres (test DB), no mocks of findByEmail or signJWT.
Setup: one user fixture seeded into test DB with bcrypt-hashed pw.
Run: npm test -- auth/login.integration.

Implement: <how to make the test pass - file paths, logic, prior step outputs to use>. Do not modify the test file once written.
```

### 3. Cover coverage levels across the plan

After every step has a spec, summarize the coverage levels that appear -
unit, integration, e2e, manual. If a check has `integration_level: e2e`
but every step tracing to it has only unit-level Test boundaries, that's
a mismatch - flag it.

### 4. Identify data requirements

For the feature as a whole, list fixtures, seeded data, stubs of
*external* services (never the unit under test), env vars / feature
flags needed across steps. Be specific:

- "A logged-in user" - insufficient.
- "A user with `role=editor` who has not completed onboarding, and a second user with `role=admin` who has 0 existing records" - sufficient.

Data requirements live in `decisions[]` (rationale) and as `Setup:` lines
inside the relevant step's Test block.

### 5. Surface mismatches

Output:

- Checks with no step tracing to them (orphan checks - blocker; back to plan).
- Steps with no `traces_to` (orphan steps - either remove or add the missing check).
- Steps where the Test boundary is weaker than the highest `integration_level` among traced checks (mismatch - upgrade the boundary or add an integration setup step).
- Setup steps required for missing test infrastructure (called out so the planner adds them).

### 6. Write the updated steps

```
tend_update_feature({
  id: "<id>",
  changes: {
    steps: [ /* steps with Test blocks complete in each description */ ]
  }
})
```

The MCP write side-effect recomputes progress and may invalidate audit
(if a step's `description` or `traces_to` changed materially). Slot prose
changes do not invalidate audit; spec-of-truth changes do.

## Done When

- Every agent or integration step with `traces_to` has a `Test:` block leading its `description`.
- Every check is covered by at least one step's Test block.
- Test level matches check `integration_level` for every traced check.
- No spec mocks the unit under test.
- Setup steps planned where test infrastructure is missing.
- Data requirements documented in `decisions[]` (rationale) and inline in step Test blocks (Setup lines).
- Any ambiguous checks flagged for the user (the `verification_recipe` is the source of truth - back to `/tend brainstorm` if unclear).
