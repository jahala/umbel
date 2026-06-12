# Tend Schema Reference

The data shape every tend skill writes against. Source of truth: `schema/`
in the tend-cli package (`feature.schema.json`, `catalog.schema.json`,
`adapter.schema.json`) and `src/core/types.ts`.

This reference is for skill authors and agents reading skill files. If
you're authoring a skill, every code path in your skill must match the
schema documented here.

## Polyglot is the source of truth

Each feature, subpage, and the project's garden are `.tend.html` polyglot
files. Each contains two JSON blocks inline:

| Block      | Holds                                                            |
|------------|------------------------------------------------------------------|
| `oo-meta`  | `kind` (feature \| garden \| subpage), `template_version`, etc.  |
| `oo-data`  | Everything else - identity, slots, checks, steps, audit, etc.    |

There is no separate JSON source file. The polyglot IS the artifact and
the source. Reads pull `oo-data` via `bash <file>.tend.html data | jq` or
via MCP tools that wrap that extraction. Writes go through MCP
(`tend_update_feature`, etc.); MCP extracts `oo-data`, merges, validates,
and splices back atomically.

```
docs/tend/
├── overview.html                   <- garden polyglot (project bet)
└── features/
    ├── <id>.tend.html              <- feature polyglot
    └── <parent-id>.<slug>.tend.html  <- subpage polyglot (drills into one parent check)
```

## Recursive schema: same shape at every level

Garden, feature, and subpage are structurally the same kind of thing: a
bet that gets verified. The common core is the same for all three:

- Six slot strings (`what / why / impact / fit / where / how`)
- `checks[]` - each anchored to a slot via `validates`
- `audit` - verdicts per check, with a result
- `status` - gated: `verified` requires `audit.result === 'pass'`
- `progress` - implementation% + verification%
- `decisions`, `understanding`, `references`, `cost`

What differs is the structural pointer to children:

| Kind     | Adds                                                                       |
|----------|----------------------------------------------------------------------------|
| garden   | `catalog`, `features_aggregate` (denormalized rollup), strategy content    |
| feature  | `personas` / `solves` / `journey_phase`, `dependencies` / `enables`, `steps[]`, child subpages, `smoke.cmd` |
| subpage  | `parent` (required), optional `proves_feature_check`, `steps[]`, `smoke.cmd` |

The hierarchy is exactly three levels - garden -> feature -> subpage.
Subpages do not nest further.

## Six slot strings (top-level on every feature)

`what`, `why`, `impact`, `fit`, `where`, `how` - one-liner claims at any
level. All optional; gap-cards surface empties. They pair into three
mental threads for display:

| Thread  | Slots             | What it says                                              |
|---------|-------------------|-----------------------------------------------------------|
| Product | `what` + `why`    | What we're building and why it matters to the user        |
| Value   | `fit` + `impact`  | How it fits the roadmap, and what change in the world     |
| Tech    | `where` + `how`   | Where in the code and the technical approach              |

The bet article groups the slots by these threads for the reader. Data
stays flat in `oo-data` - the threads are a *mental model* only, not a
data shape.

Scale-dependent rendering: garden slots may be visionary, with images and
diagrams; feature/subpage slots are tactical one-liners. Renderer reads
`oo-meta.kind` and adjusts density. The schema doesn't enforce density.

## Checks (the validators)

Each check verifies one slot's claim. Definitions:

```json
{
  "id": "c001",
  "description": "User logged in with valid credentials reaches the dashboard within 500ms.",
  "validates": "what",
  "method": "synthetic-test",
  "status": "open",
  "integration_level": "e2e",
  "verification_recipe": "POST /auth/login with seeded user; assert 302 -> /dashboard; assert nav latency p95 < 500ms"
}
```

| Field                  | Required | Description                                                                 |
|------------------------|----------|-----------------------------------------------------------------------------|
| `id`                   | yes      | Unique within this feature (e.g., `c001`)                                   |
| `description`          | yes      | What must be true for this check to pass                                    |
| `validates`            | no       | Which slot this check anchors to (`what`/`why`/`impact`/`fit`/`where`/`how`)|
| `method`               | no       | `synthetic-test` \| `code-review` \| `user-report` \| `analytics-metric` \| `agent-judgment` |
| `status`               | no       | Authoring state: `open` (default) or `needs-clarification`                  |
| `integration_level`    | no       | `unit` \| `integration` \| `e2e` \| `manual` - the verification surface     |
| `verification_recipe`  | no       | One-line answer to "how do I know this is satisfied?" - concrete enough to write a failing test from |

No headline flag on checks. Sort order handles display priority if needed.

## Steps (the implementation plan)

Each step is an atomic unit of work that proves one or more checks.

```json
{
  "id": "i001",
  "title": "Implement login endpoint",
  "status": "pending",
  "step_type": "agent",
  "description": "Test: tests/auth/login.integration.test.ts. Asserts: POST /auth/login ... Run: npm test -- auth/login.integration.\n\nImplement: Create POST /auth/login in src/auth/handlers/login.ts. ...",
  "traces_to": ["c001", "c002"],
  "dependencies": ["i000"],
  "verification_profile": "standard",
  "agent_hint": { "model": "sonnet", "isolation": "worktree", "error_strategy": "fail" },
  "outputs": { "login_endpoint": "POST /auth/login" }
}
```

| Field                  | Required | Description                                                                 |
|------------------------|----------|-----------------------------------------------------------------------------|
| `id`                   | yes      | Unique within this feature (e.g., `i001`)                                   |
| `title`                | yes      | One-line summary                                                            |
| `description`          | no       | Self-contained step content; for agent steps with `traces_to`, leads with a `Test:` block then an `Implement:` block (see "Test-first" below) |
| `status`               | no       | `pending` (default) \| `in-progress` \| `done` \| `skipped` \| `failed`     |
| `step_type`            | no       | `agent` \| `command` \| `worktree` \| `integration`                         |
| `traces_to`            | no       | Check IDs this step is responsible for satisfying (many-to-many allowed)    |
| `dependencies`         | no       | Step IDs in this feature that must be `done` first                          |
| `verification_profile` | no       | `light` \| `standard` (default) \| `thorough`                               |
| `verification`         | no       | `{ type, file?, pattern?, approver_role? }`                                 |
| `agent_hint`           | no       | `{ model, isolation, error_strategy, max_retries, capabilities, ... }`      |
| `outputs`              | no       | Named outputs downstream steps may reference (e.g., `{ api_url: "..." }`)   |
| `artifacts`            | no       | `[{ path, action: created \| modified \| deleted }]` - filled by run        |

## Audit (the verdicts)

```json
{
  "ran_at": "2026-05-15T12:00:00Z",
  "result": "pass",
  "verdicts": [
    { "check_id": "c001", "verdict": "pass", "evidence_path": "src/auth/login.ts:42; tests/auth/login.integration.test.ts:18" },
    { "check_id": "c002", "verdict": "partial", "evidence_path": "tests/auth/login.unit.test.ts:7 (mocks findByEmail; needs integration evidence)" }
  ],
  "drift": [
    { "finding": "Undocumented magic-link handler", "file": "src/auth/magic-link.ts", "action": "document or remove" }
  ]
}
```

- `result` is `pass` | `partial` | `fail` - written by `tend-audit` only.
- A `pass` result requires every check to have `verdict: pass`; smoke (if defined) must also pass.
- `verdicts[].verdict` is `pass` | `partial` | `fail`.
- `audit.result === 'pass'` is the gate to `status: "verified"` - `tend_update_feature` rejects the transition otherwise.

## Status (locked enum, gated)

`status` on a feature is **only** `planned`, `in-progress`, or `verified`.

| Status        | Meaning                                                                |
|---------------|------------------------------------------------------------------------|
| `planned`     | Feature has slots/checks but no `done` steps                           |
| `in-progress` | At least one step is `in-progress`; or some `done`, some not          |
| `verified`    | `audit.result === 'pass'` on disk - the single hard gate              |

The catalog (top-level) has its own status enum for the project as a
whole. Don't confuse the two.

## Progress (computed)

```json
{
  "implementation": 60,
  "verification": 50
}
```

- `implementation` - percent of steps with `status: done` (skipped counts as done)
- `verification` - percent of checks with `verdicts[].verdict === 'pass'`

Both are auto-recomputed by MCP write side-effects. Agents never call a
recompute tool manually.

## Smoke test

```json
{
  "cmd": "npm run test:e2e -- auth/login.smoke",
  "verify": "all 5 tests passed",
  "last_run": "2026-05-15T12:00:00Z",
  "last_result": "pass"
}
```

End-to-end check that proves the feature works as a whole. Authored by
`tend-brainstorm`. Executed by `tend-audit` (and by the bash `smoke` verb
on the polyglot). Smoke failure prevents `audit.result === 'pass'`.

## Auto-side-effects on every MCP write

Every `tend_*` write triggers, inside the tool, atomically:

1. **Pre-write validation** - schema, template-version match, blast-radius refusals (e.g., cannot delete a feature that is in another feature's `dependencies`).
2. **Audit auto-invalidation** - if the write touches spec-of-truth fields (checks added/removed, `validates` / `method` / `integration_level` changed, steps changed, `smoke.cmd` changed), `audit` is cleared and `status` drops from `verified` to `in-progress` unless the same call writes a fresh `audit.result === 'pass'`. Slot prose, decisions, dependency lists, and catalog refs do not invalidate audit.
3. **Recursive cascade** - if this is a subpage with `proves_feature_check: X`, the parent feature's verdict for X moves to `partial`/`fail` and the parent's audit may invalidate. Project-level audit is not auto-cascaded; project audit is re-evaluated manually.
4. **Recompute** `progress.implementation` and `progress.verification`.
5. **Refresh snapshots** - garden's `features_aggregate[X]` for the touched feature; sibling features' snapshots of X (only if X's title / status / progress changed).
6. **Splice** updated `oo-data` back into the polyglot atomically.

Agents never call recompute / refresh / aggregate tools manually under
normal flow. Writes are consistent by default.

## Catalog auto-stub

When a feature references a catalog ID that doesn't exist yet
(`personas: ["new-id"]`, `solves: ["opp-new"]`, etc.), MCP writes do not
reject - they auto-create a stub in `catalog.<kind>` marked
`status: draft`, surfaced as a gap by `tend_get_gaps` until filled out.

This enables brainstorm flow without "you must define the persona first"
gates while keeping accountability visible.

## Test-first (universal, no opt-out)

Tend's flow is test-first across every layer. There is no
`testing_strategy` field - the discipline is structural:

| Layer            | What it produces                                                               |
|------------------|--------------------------------------------------------------------------------|
| `tend-brainstorm`| Every check has a `verification_recipe` - a one-liner concrete enough to write a failing test from |
| `tend-plan`      | Every step's `description` leads with a `Test:` block (file path, asserts, boundary, setup, run command) then an `Implement:` block |
| `tend-run`       | Per agent step with `traces_to`: PRE -> RED (write failing test) -> IMPL (make it pass; do not modify the test) -> GREEN (re-run; verify pass) -> POST -> VERIFY -> DOC. Command/worktree/traceless steps skip RED/GREEN |
| `tend-audit`     | Per check, confirm a test exists, exercises the unit under test (not exclusively through mocks), and currently passes |

If RED reports the test passes immediately, the workflow stops - the
check is already implemented or the test is wrong. The IMPL prompt always
includes the don't-modify-the-test constraint.

## Step description structure

For agent steps with `traces_to`, the description must lead with a
`Test:` block and follow with an `Implement:` block:

```
Test: <test file path>
Asserts: <inputs and expected outputs/state, derived from each traced check's verification_recipe>
Boundary: <real DB / real HTTP / real browser / pure function / etc. - matching the highest integration_level among traced checks>
Setup: <fixtures, seeded data, env, external stubs (only for genuinely external deps)>
Run: <exact command>

Implement: <files to create/modify, logic, prior step outputs to use>. Do not modify the test file once written.
```

Command and worktree steps don't need the Test/Implement split - their
exit code is the test.

Other rules:

1. Exact file paths to create/modify/delete (in the Implement block).
2. Concrete instructions - the logic, not "implement X".
3. No external context references - never write "see feature summary" or "as described above".

## User-flow steps

User-flow is a *style* of step, not a separate field. Inside `feature.steps[]`,
agent/manual steps that describe user-visible journeys use tagged titles:

| Tag        | Meaning                                                              |
|------------|----------------------------------------------------------------------|
| `[action]` | User performs a discrete interaction (click, submit, navigate, type) |
| `[assert]` | An observable outcome is verifiable (visible text, state, redirect)  |
| `[system]` | A backend side-effect occurs (record created, email sent, session)   |

`[assert]` steps are e2e by definition - they observe user-visible state
in a running app. Checks satisfied solely by `[assert]` steps default to
`integration_level: e2e`.

## Verification types (per step)

| Type               | When                                                | Example                                                    |
|--------------------|-----------------------------------------------------|-----------------------------------------------------------|
| `exit_code`        | Step runs a test suite or build                     | `npm test` exits 0                                         |
| `file_exists`      | Step creates a file                                 | `{ type: "file_exists", file: "src/auth/login.ts" }`       |
| `output_matches`   | Command output must match                           | `{ type: "output_matches", pattern: "tests passed" }`      |
| `human_approval`   | Requires human sign-off                             | `{ type: "human_approval", approver_role: "tech-lead" }`   |

## Verification profiles

| Profile     | When                                                                |
|-------------|---------------------------------------------------------------------|
| `thorough`  | Auth, security, payments, encryption, data migration                |
| `standard`  | Cross-component steps, 3+ checks, new modules. Default.             |
| `light`     | Config, docs, rename, format; `command` steps                       |

## Feature graph

Two relationship types between features:

- `dependencies` - technical blockers (cannot build B without A verified)
- `enables` - user journey edges (after A, the user can do B)

Dependencies block work order. Enables express the user journey and are
independent of dependencies. DAG only; cycles rejected.

## Section ownership

| Section                                     | Skill                                              |
|---------------------------------------------|----------------------------------------------------|
| Slots (`what`/`why`/`impact`/`fit`/`where`/`how`) | `tend-brainstorm` (defines), `tend-change` (modifies) |
| `checks[]`                                  | `tend-brainstorm` (defines), `tend-change`         |
| `personas`, `solves`, `journey_phase`       | `tend-brainstorm` / `tend-discover`                |
| `entry_condition`, `exit_condition`         | `tend-plan`                                        |
| `smoke`                                     | `tend-brainstorm` (defines), `tend-audit` (writes `last_run` / `last_result`) |
| `steps[]`                                   | `tend-plan` (defines), `tend-run` (updates status / log / artifacts) |
| `steps[].traces_to`                         | `tend-plan` - check IDs each step proves           |
| `understanding`                             | Any (ideation observations)                        |
| `decisions[]`                               | Any                                                |
| `audit.*`                                   | `tend-audit` only                                  |
| `status = "verified"`                       | `tend-audit` only (gated by `audit.result === 'pass'`) |
| `progress.*`                                | Auto-computed (MCP side-effect)                    |
| `dependencies`, `enables`                   | `tend-brainstorm` / `tend-change`                  |
| `references[]`                              | Any                                                |
| `catalog.components`                        | `tend-brainstorm` / `tend-discover`                |
| `catalog.personas`                          | `tend-brainstorm`                                  |
| `catalog.opportunities`                     | `tend-brainstorm`                                  |
| `catalog.journey_phases`                    | `tend-brainstorm`                                  |
| Garden `features_aggregate`                 | Auto-refreshed (MCP side-effect; `tend_aggregate` to force) |

## MCP tools (target inventory: 14)

| Cluster              | Tools                                                                  |
|----------------------|------------------------------------------------------------------------|
| Writes               | `tend_create_feature`, `tend_update_feature`, `tend_delete_feature`, `tend_update_catalog`, `tend_topic_add`, `tend_topic_remove` |
| Computed discovery   | `tend_get_gaps`, `tend_get_unblocked`, `tend_get_context`              |
| Validation           | `tend_validate`, `tend_check_coherence`, `tend_validate_topics`        |
| Project ops          | `tend_aggregate`, `tend_output_execution_plan`                         |

Reads use the polyglot's bash data verb plus jq, or `tend_get_context`
when you need feature + resolved deps + suggested-action in one call.

## Bash verbs (per polyglot)

Five built-ins + custom-verb extension fallback:

| Verb               | Purpose                                                                      |
|--------------------|------------------------------------------------------------------------------|
| `data`             | Dump `oo-data` as JSON for jq piping                                         |
| `status`           | One-line identity + progress overview                                        |
| `help`             | List verbs (including topic-added ones)                                      |
| `run`              | Orchestrate the build: iterate `steps[]`, invoke agent per step, run smoke   |
| `smoke`            | Run `oo-data.smoke.cmd`; exit 0/non-0                                        |
| `cmd_<topic-verb>` | Topic extension point (custom-verb fallback)                                 |

Multi-file ops (validate, aggregate, sync) live in MCP (agentic) or CLI
(project-level), not in bash. Mutations to feature content live in MCP.

## CLI commands (project-level setup + maintenance)

```bash
npx tend-cli init              # Scaffold skills + MCP config + project structure
npx tend-cli serve             # Start MCP server (stdio)
npx tend-cli sync              # Re-sync canonical partials to all polyglots
npx tend-cli aggregate         # Force-rebuild garden's features_aggregate
npx tend-cli refresh-refs <f>  # Force-refresh denorm snapshots in one polyglot
npx tend-cli import <legacy>   # One-shot legacy JSON to polyglot migration
npx tend-cli validate          # Full project validation (no MCP needed)
npx tend-cli ui                # Build static dashboard HTML
npx tend-cli adapter <cmd>     # Adapter management (list / add / remove)
```

## Topics (custom extensions)

`OO:CUSTOM` is the third-party extension zone in every polyglot. Topics
register through four extension points: data blocks, renderers, shell
verbs (`cmd_<verb>` fallback), and CSS namespaces. See
`docs/research/extension-contract.md` for the canonical contract, naming
conventions, and refcount lifecycle rules.

Tend ships ZERO first-party topics. The topic mechanism is the
extension surface. UI/UX, security, billing, platform, analytics - all
project-defined.
