# User-Flow Procedure

**Owns**: tagged `[action]`/`[assert]`/`[system]` steps inside `feature.steps[]`.

## Purpose

Document the user journey as atomic, testable steps. These become the
source for e2e test cases - each `[assert]` step is an observable
behavior in a running app.

## Prerequisites

- Feature must have at least slot `what` and `checks[]` non-empty.
- If the feature has UI but `journey_phase` / `personas` are missing,
  note that step descriptions may need revision once those are defined,
  and offer to run `/tend brainstorm` first.

## Rules

- Every `[action]` must be followed by at least one `[assert]`.
- Every `[system]` step must eventually be verified by a downstream `[assert]`.
- Steps must be atomic - one thing per step, not "user fills out and submits the form".
- Step descriptions are implementation-agnostic - describe observable behavior, not code. No function names, no database calls, no component names.
- Cover the happy path fully before adding error/edge paths.
- Do not invent behavior not implied by the feature's checks.
- **`[assert]` steps are e2e by definition.** They observe user-visible state in a running app. Checks satisfied solely by `[assert]` steps default to `integration_level: e2e` - they require a real browser or device to verify. A unit test that asserts on a mocked DOM element is not e2e evidence.
- Tagged steps live in the same `feature.steps[]` array as implementation steps. Distinguish them by the `[action]`/`[assert]`/`[system]` prefix in the title.

## Workflow

### 1. Walk the journey

Identify the full sequence from the user's entry point to completion:

- **Happy path** - everything works as expected
- **Error paths** - invalid input, network failure, permission denied
- **Edge cases** implied by checks

### 2. Write steps

Step tags (go in the step `title`):

- `[action]` - the user performs a discrete interaction (click, submit, navigate, type)
- `[assert]` - an observable outcome is verifiable (visible text, state change, redirect, toast)
- `[system]` - a backend side-effect occurs (record created, email sent, session started)

Step shape:

```json
{
  "id": "uf-login-01",
  "title": "[action] User submits login form",
  "step_type": "agent",
  "description": "User enters valid email and password, then activates the submit control.",
  "traces_to": []
}
```

```json
{
  "id": "uf-login-02",
  "title": "[assert] User is redirected to dashboard",
  "step_type": "agent",
  "description": "The application navigates the user to their dashboard view. Test: tests/e2e/auth/login.spec.ts. Asserts: after submitting the login form, URL becomes /dashboard and the dashboard heading is visible. Boundary: real browser (Playwright). Run: npm run test:e2e -- auth/login.\n\nImplement: covered by the [action] uf-login-01 implementation; this assert step verifies the redirect.",
  "traces_to": ["c001"]
}
```

```json
{
  "id": "uf-login-03",
  "title": "[system] Session is created",
  "step_type": "agent",
  "description": "A session token is issued and persisted for the user. (Verified downstream by uf-login-02 observing the redirect, and by any subsequent authenticated [assert].)",
  "traces_to": []
}
```

`[assert]` steps carry `Test:` blocks (they're real e2e checks); `[action]`
and `[system]` steps don't always (they describe what happens; the
downstream `[assert]` proves it).

### 3. Verify coverage

Before writing:

- Every `[action]` has a following `[assert]`.
- Every `[system]` has a downstream `[assert]` confirming it happened.
- Each check has at least one `[assert]` step that traces to it.

### 4. Write the flow

```
tend_update_feature({
  id: "<id>",
  changes: {
    steps: [
      /* ...existing implementation steps... */,
      /* ...new tagged user-flow steps appended... */
    ]
  }
})
```

The MCP write side-effect recomputes progress and (if applicable)
invalidates audit for the touched checks.

## Done When

- Every check has at least one `[assert]` step tracing to it.
- Every `[action]` is followed by at least one `[assert]`.
- Every `[system]` has a downstream `[assert]`.
- Happy path and all error paths implied by checks are covered.
- No implementation details appear in step descriptions (titles and prose are observable-behavior only).
