# Security Analysis Procedure

**Writes to**: `checks[]` (critical/high findings as security checks),
`decisions[]` (rationale, compliance choices, mitigation trade-offs),
optionally `steps[]` (steps that implement security mitigations).

## Purpose

Identify actionable security findings for this feature. Not a full threat
model - focused on what implementation needs to act on.

## Rules

- **Actionable findings only** - no theoretical risks, no hypothetical scenarios that don't apply to this feature.
- **OWASP Top 10 as baseline** - check each relevant category, skip ones that genuinely don't apply.
- **Match security to risk level** - a public read-only dashboard gets different treatment than a payment flow.
- **Flag PII, auth, and external integrations** - always, without exception.
- **Compliance is a human decision** - ask the user before adding compliance requirements (GDPR, HIPAA, SOC2, etc.).
- **Don't over-engineer** - three focused findings that get implemented beat ten theoretical ones that get ignored.
- **Every finding has a mitigation** - if you can't suggest a concrete mitigation, flag it for human review instead.
- **Security checks default to non-unit.** Auth, authorization, scoping, and upload handling cannot be proven by unit tests - mark them `integration` or `e2e` and write a real verification recipe.

## Workflow

### 1. Identify security-relevant aspects

Check each of the following against the feature. Skip categories that
genuinely don't apply.

**Authentication and authorization**

- Does the feature have access control? Who can do what?
- Are there role or permission boundaries? Are they enforced server-side?
- Does the feature touch session management or token handling?

**Data storage and retrieval**

- What data is written to the database? Is any of it sensitive?
- Are queries parameterized? Any risk of injection?
- Is data scoped correctly per user/tenant?

**API endpoints and inputs**

- What user input is accepted? Is it validated and sanitized?
- Are rate limits or abuse protections needed?
- Are error responses leaking internal details?

**File uploads and external data**

- If files are accepted: type validation, size limits, storage location, execution risk.
- If external data is consumed: validation, schema enforcement, safe parsing.

**Third-party integrations**

- What external services are called? Are credentials stored safely?
- What data is sent to third parties? Is this acceptable?
- What happens if the integration fails or returns unexpected data?

**PII handling**

- Is personally identifiable information collected, stored, or transmitted?
- If yes: **stop and ask the user** about retention, encryption, and compliance requirements before continuing.

### 2. Document each finding

For each finding:

- **Aspect**: which category above
- **Threat**: what could go wrong (one sentence, concrete)
- **Mitigation**: what to implement (specific, actionable)
- **Risk level**: `critical` | `high` | `medium` | `low`
  - `critical` - exploitable without authentication, or exposes all user data
  - `high` - exploitable by authenticated users, or exposes one user's data
  - `medium` - requires specific conditions, limited impact
  - `low` - defense in depth, hardening
- **Needs human review**: true/false - flag if the mitigation requires a decision above implementation level

### 3. Ask about compliance if needed

If the feature handles PII, financial data, health data, or other
regulated categories, ask:

> "This feature handles [describe data]. Are there compliance requirements to follow? (GDPR, HIPAA, SOC2, PCI, other)"

Wait for the answer. Document the response in `decisions[]`.

### 4. Add security checks

For each `critical` or `high` finding, append a security check to
`checks[]` via `tend_update_feature`. Examples:

```json
{
  "id": "sec-1",
  "description": "All API endpoints require authentication - unauthenticated requests return 401.",
  "validates": "where",
  "method": "synthetic-test",
  "integration_level": "integration",
  "verification_recipe": "For each endpoint, send a request without auth header; expect 401."
}
```

```json
{
  "id": "sec-2",
  "description": "User data is scoped by user ID - no query returns another user's records.",
  "validates": "how",
  "method": "synthetic-test",
  "integration_level": "integration",
  "verification_recipe": "Seed two users with records. Authenticate as user A. Request any list/get endpoint. Assert no record with user_id = B appears."
}
```

```json
{
  "id": "sec-3",
  "description": "File uploads are restricted to declared types, max size, stored outside webroot.",
  "validates": "where",
  "method": "synthetic-test",
  "integration_level": "e2e",
  "verification_recipe": "Upload a .php file; expect 400. Upload a 100MB file; expect 413. Confirm uploaded files do not appear under any web-served path."
}
```

**Security checks default to `integration_level: integration` or `e2e`.**
Auth, authorization, scoping, and upload handling cannot be proven by
unit tests. Mock-based unit tests of auth functions are not security
verification.

`validates`:

- Auth/access checks usually anchor to `where` (the implementation path that enforces it) or `how` (the technical approach to enforcement).
- Behavior-of-the-feature checks anchor to `what`.
- Compliance-driven posture often anchors to `fit` or `impact`.

Lower-risk findings appear in `decisions[]` only, as the mitigation
rationale.

### 5. Add implementation steps if needed

If any finding requires dedicated work not covered by the existing plan
(e.g., rate limiting middleware, field encryption, security headers),
append agent steps to `steps[]`. Each new step traces to the security
check it implements, leads with a `Test:` block, and uses
`verification_profile: "thorough"`.

### 6. Write all changes

```
tend_update_feature({
  id: "<id>",
  changes: {
    checks: [
      /* existing checks preserved by by-id merge; new security checks appended */
    ],
    steps: [
      /* existing steps preserved by by-id merge; new mitigation steps appended */
    ],
    decisions: [
      { id: "d-sec-001", at: "<ISO>", decision: "...", rationale: "..." }
    ]
  }
})
```

MCP merges arrays of objects by `id`, so existing entries are preserved
and only the new ones land.

## Done When

- Every security-relevant aspect evaluated.
- All `critical` and `high` findings have checks in `checks[]` with appropriate `validates`, `integration_level`, `method`, and `verification_recipe`.
- All compliance answers and mitigation rationale documented in `decisions[]`.
- Security-only implementation steps added where existing steps don't cover the mitigation; each traces to a security check.
- Checks specific enough that a test can be written from the verification recipe.
