---
name: tend-discover
description: One-time bootstrap that walks an existing codebase and creates feature polyglots for what's already built. Trigger when the user asks "what features exist?", "map the codebase", or wants to document an existing project that has no docs/tend/ files yet. Distinct from brainstorm - the input is code, not an idea.
user-invocable: false
---

# Discover: Existing Code -> Feature Polyglots

**Owns**: feature polyglot creation from observed code, plus catalog
components / personas / journey phases inferred from the code.

## What this skill assumes

- The codebase exists and is readable — this is a one-time bootstrap that maps existing code into tend features.
- The user accepts that discovered checks default to `validates_job: null` (code carries no human-intent signal). After discovery, `/tend position` plants ICPs/Jobs and `/tend brainstorm` / `/tend change` anchors checks to them.
- This skill does NOT discover opportunities. Those come from human conversation (`/tend position`), not from code.
- After this skill, the next leverage move is `/tend position` (plant the spine), then `/tend audit` (claim coverage feature-by-feature).

## Purpose

Reverse-engineer a feature map from an existing codebase. The input is
the repo itself - routes, modules, tests, public exports - and the output
is a set of feature polyglots whose slot claims describe what exists today,
checks describe what tests already prove, and `audit` is empty until
`/tend audit` validates them.

`tend-discover` is a **one-time bootstrap** for a codebase that has no
`docs/tend/` files yet. After bootstrap, new features come from
`/tend brainstorm`; changes to existing features go through
`/tend change`.

## Output

- `docs/tend/overview.html` - garden polyglot with catalog (via `tend_update_catalog`)
- `docs/tend/features/<id>.tend.html` - one feature polyglot per discovered surface (via `tend_create_feature` then `tend_update_feature`)

## Rules

- Ask the user for choices and confirmation. Do not proceed on assumptions when intent is ambiguous.
- Ask the user to confirm the component list before creating any feature polyglots.
- All writes go through MCP - never edit `.tend.html` files as text.
- Checks must be **assertions** (checkable outcomes), not tasks.
- Infer checks from existing tests where possible; mark inferred ones explicitly with `(inferred from test)` in the description.
- **Every inferred check carries `validates`**, the slot the test seems to prove. Default `validates: what` if it tests behavior; `validates: where` if it tests structure; ask the user when ambiguous.
- **Mock-aware inference.** If a test mocks the function or component the check is about (e.g., `vi.fn()` returns the value the check describes; the integration boundary is stubbed), the test is not real evidence - it proves the mock returns what you told it to. When inferring a check from such a test, mark the check description with `(inferred from mocked test - needs real verification)` and propose `integration_level: integration` (or `e2e` if a runtime is involved). Do not let the test's "passing" status bias you.
- **Default integration_level: unit, but watch for signals.** Tests that hit real DBs, real HTTP servers, real browsers, or real filesystems are evidence for `integration` or `e2e` checks. Tests that import only the unit under test and call its function directly (no boundaries) are evidence for `unit` checks.
- Set both `dependencies` (technical blockers) and `enables` (user journey edges) where discoverable from the code (import graph, route guards, redirect flows).
- All discovered features default to `status: "planned"` even though the code exists. **Do not** set `status: "verified"` - that requires `audit.result === 'pass'` with real evidence per check. Discover only claims the code *exists*; `tend-audit` confirms it *works*.
- After completion: tell the user to run `/tend audit` to verify discovered checks against real evidence; surface any inferred-from-mock or `(needs real verification)` checks as the priority targets.

## Workflow

### 1. Check existing state

Read the garden's catalog via the polyglot's data verb:

```bash
bash docs/tend/overview.html data 2>/dev/null | jq '.catalog' || echo 'no garden yet'
```

If docs already exist, show existing components and features, then ask:
"Extend existing catalog or re-discover from scratch?" If nothing exists,
proceed.

### 2. Scan codebase (breadth first)

Read key files to understand structure:

- `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `Gemfile` / equivalent - tech stack, scripts, dependencies
- `README.md` - stated purpose and feature descriptions
- Directory layout - identify component roots (e.g., `src/`, `api/`, `web/`, `db/`, `cli/`, `firmware/`)
- Test files - check candidates often live here; infer feature intent from test names

Sample representative files per directory rather than reading every file.

### What's a top-level feature vs a subpage?

Before enumerating anything, apply this filter to every candidate concept. A discovered concept belongs at the **top level** only when a persona performs a named task verb at its surface (`orient | author | plan | build | verify | review`) and there is a user-visible entry and exit condition. Anything else belongs as a **subpage** of the user-facing surface it implements.

**Subpage signal** — any one present means propose a subpage, not a top-level feature:

- The code lives inside a larger user-facing surface and has no standalone user-visible outcome of its own. Examples: `src/db/connection.ts` inside the API layer → child of `api-server`; a shared auth middleware → child of `auth`; a validation helper → child of `checkout`.
- The module name reads as a mechanism, helper, primitive, or internal contract: `*-parser`, `*-validator`, `*-schema`, `*-scaffold`, `*-assembler`, `*-handler`, `*-core`, `*-utils`.
- No persona would describe their job as "I use the X module directly" — they use the feature that wraps it.

**What to do when subpage signal is present:**

1. Identify the user-facing parent: which top-level surface (CLI command, MCP tool cluster, UI view, etc.) does this code serve?
2. Propose the concept as a subpage of that parent — not a sibling feature. Set `parent: '<parent_id>'` via `tend_update_feature` after creation.
3. If the parent feature does not exist yet, note it as a pending parent and create the parent first before the subpage.
4. Surface your reasoning to the user: "I'm proposing `<id>` as a subpage of `<parent>` because it implements an internal mechanism with no standalone user-visible outcome. Does that sound right?"

Apply this reasoning on the first pass. Do not default every discovered file to a top-level feature and let the user demote later — that is exactly what pollutes the journey view and DAG with infrastructure clutter.

### What's a feature in this project shape?

Pick the right "feature surface" for the project before enumerating:

| Project shape         | Feature surface                          | Examples                                                            |
|-----------------------|------------------------------------------|---------------------------------------------------------------------|
| Web frontend          | Routes, pages, top-level views           | `/login`, `/dashboard`, `/settings/billing`                         |
| Web/API backend       | Endpoints, resource handlers             | `POST /auth/login`, `GET /users/:id`, webhook handlers              |
| CLI tool              | Commands and major flags                 | `tool init`, `tool build --watch`, `tool deploy`                    |
| Library / SDK         | Public exports                           | Exported functions, classes, hooks, components                      |
| Mobile app            | Screens / navigation destinations        | Onboarding flow, settings tab, push-notification handler            |
| ML / data pipeline    | Pipeline stages                          | Ingestion, feature extraction, training, eval, serving              |
| Smart contract        | Public methods + events                  | `mint`, `transfer`, `Withdrawal` event, upgrade path                |
| Embedded firmware     | Subsystems / device modes                | Sensor read loop, OTA update, sleep/wake transitions                |
| Game (Unity/Unreal)   | Systems and gameplay loops               | Inventory, combat, save/load, multiplayer matchmaking               |
| Infra / Terraform     | Modules and environment configs          | `vpc/`, `eks/`, `dev`/`staging`/`prod`                              |

Identify the surface that fits the project, then use it to enumerate
features. Don't shoehorn a Rust library into "routes and pages."

### 3. Identify components

From the scan, identify all distinct components:

- `id`, `name`, `tech[]`, `path` for each
- Typical components: `backend`, `frontend`, `mobile`, `database`, `worker`, `cli`

Ask the user to confirm: "I found these components: [list]. Does this
look right, or should I adjust?"

Once confirmed, call `tend_update_catalog` with components and project
metadata.

### 4. Identify features and their slots

From routes, pages, modules, and tests, identify discrete features. For
each, propose values for the six slots based on what the code shows:

| Slot     | Where to look                                                                  |
|----------|--------------------------------------------------------------------------------|
| `what`   | Route handler description, top function comment, module header                 |
| `why`    | README section, JSDoc, user-facing copy in the UI                              |
| `impact` | Often genuinely missing - ask the user or mark a gap                           |
| `fit`    | Roadmap/strategy doc if present; otherwise gap                                 |
| `where`  | The file path(s) the feature lives in - directly observable                    |
| `how`    | One-liner describing the implementation approach (auth backend, ORM, etc.)     |

Slots you can't infer with reasonable confidence: omit. Empty slots
surface as gap-cards via `tend_get_gaps` and the user (or
`tend-brainstorm`) fills them in.

Also infer journey context for each feature - mark inferred values as
best-guess (brainstorm refines later):

- **`journey_phase`** - the canonical vocabulary is exactly the six
  user-task verbs: `orient | author | plan | build | verify | review`. These
  are the *only* legal values (`tend_validate`'s `journey_phase_valid` rejects
  anything else), and you must seed `catalog.journey_phases` with exactly these
  six in step 5. Infer the closest verb from route / surface patterns:
  - `/onboarding/*`, `/auth/*`, `/login`, `/signup`, `/welcome` -> `orient`
  - create / compose / editor / `/settings/*`, `/account/*` surfaces -> `author`
  - planning / scheduling / step-builder surfaces -> `plan`
  - run / execute / build / deploy surfaces -> `build`
  - test / check / validate / audit surfaces -> `verify`
  - `/dashboard/*`, `/home`, list / report / read-only views -> `review`
  - Unknown: omit the field rather than guess
- **`personas`** - infer from auth/role checks in the code:
  - `isAdmin`, `role === 'admin'`, `hasRole('admin')` -> `admin`
  - `req.user`, `currentUser`, `useAuth()` -> `authenticated-user`
  - No auth check -> `anonymous`
  - Record each discovered role in a log note for catalog population (step 5)
- **`entry_condition`** - infer from route guards, middleware, and auth requirements
- **`exit_condition`** - infer from success redirects, response patterns, and final UI state changes

### 5. Update catalog

Call `tend_update_catalog` with:

- `components` array (confirmed in step 3)
- `project_id`, `name`, `description` inferred from README / package.json
- `status: "approved"` (discovered features are already real)
- `journey_phases` - seed with exactly the canonical six user-task verbs:
  `["orient", "author", "plan", "build", "verify", "review"]`. These are the
  only legal `journey_phase` values; do not invent project-specific phases.
- `personas` - populated from roles discovered in step 4 (e.g., `anonymous`, `authenticated-user`, `admin`)

All catalog journey data is marked best-guess - brainstorm refines
definitions and adds descriptions.

### 6. Create feature polyglots

For each discovered feature, call `tend_create_feature`:

```
tend_create_feature({
  id: "auth-login",
  title: "User Login",
  status: "planned",
  priority: "high",
  dependencies: [],
  enables: ["dashboard"],
  journey_phase: "orient",
  personas: ["anonymous"],
  entry_condition: "User is not authenticated",
  exit_condition: "User is authenticated and redirected to /dashboard",
  what: "Allow users to authenticate with email and password.",
  where: "src/routes/auth.ts; src/auth/handlers/login.ts",
  how: "POST handler validates credentials with bcrypt and issues a JWT in an httpOnly cookie."
})
```

Then call `tend_update_feature` to add checks inferred from tests:

```
tend_update_feature({
  id: "auth-login",
  changes: {
    checks: [
      {
        id: "c001",
        description: "User can log in with valid credentials. (inferred from tests/auth.test.ts:auth-login-valid)",
        validates: "what",
        method: "synthetic-test",
        integration_level: "integration",
        verification_recipe: "POST /auth/login with seeded user; expect 200 and token in body; expect session cookie set.",
        status: "open"
      },
      {
        id: "c002",
        description: "Invalid credentials return a clear error. (inferred from tests/auth.test.ts:auth-login-invalid - mocks findByEmail, needs real verification)",
        validates: "what",
        method: "synthetic-test",
        integration_level: "integration",
        verification_recipe: "POST /auth/login with bad password; expect 401 and error body.",
        status: "needs-clarification"
      }
    ]
  }
})
```

Mark inferred-from-mock checks with `status: needs-clarification` so they
surface in `tend_get_gaps` as a priority.

### 7. Set relationships

For each feature:

- `dependencies`: feature IDs that must be verified before this one can be built. Derived from the import graph (e.g., `dashboard` imports session middleware that depends on `auth-login`).
- `enables`: feature IDs the user reaches after this one. Derived from success redirects and route flows.

### 8. Mark unknown areas

If parts of the codebase are unclear or too large to fully map, create a
placeholder feature with `status: "planned"` and a note in the slot prose
explaining what's unknown. Flag for the user rather than guessing.

## Done When

- Catalog exists with confirmed components, `journey_phases`, and `personas` populated from discovered patterns.
- Each discovered feature has: at minimum `what` and `where` populated; other slots marked as gaps where they couldn't be inferred.
- Checks inferred from existing tests, with `validates`, `integration_level`, `method`, and `verification_recipe`.
- Mock-aware: any check whose only inferred evidence is a mocked test is marked `status: "needs-clarification"` and flagged as a priority target.
- `dependencies` AND `enables` are set where inferable from the code.
- Journey context (`journey_phase`, `personas`, `entry_condition`, `exit_condition`) inferred and set where possible; omitted where not inferable.
- All features have `status: "planned"` - never `verified`. Audit must validate before that transition.
- Gaps and unknowns are explicitly flagged via empty slots and `status: "needs-clarification"` checks; the user can resolve them via `/tend brainstorm` or `/tend audit`.

## Next move

Close the loop — don't leave the user guessing what comes next.

1. **Compute it.** Call `tend_get_next` (MCP preferred; CLI fallback
   `node dist/bin/tend.js next --json`). It reads on-disk state and
   returns the highest-leverage action with reason codes.
2. **Present it plainly.** State the recommended `action` verbatim and the
   reason in plain words (paraphrase the reason code, don't paste it).
   After a bootstrap the spine is bare, so the move is usually
   `/tend position` — *"discovered features have no persona-jobs to anchor
   checks to; plant the ICPs first."*
3. **Offer to chain — never auto-execute.** Ask before continuing:
   *"Want me to run `/tend position` now to plant the spine?"* Only
   proceed on the user's yes. If they decline, route to whichever
   sub-skill matches their intent.

The post-discover leverage order is `/tend position` (plant the spine) →
`/tend audit` (claim coverage feature-by-feature, prioritizing the
inferred-from-mock checks) → `/tend brainstorm` (new features not yet in
code). Let `tend_get_next` confirm the first step rather than assuming.
