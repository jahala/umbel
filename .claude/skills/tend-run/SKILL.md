---
name: tend-run
description: Take a feature from plan to execution. Either run the polyglot directly via `bash <file>.tend.html run` (single-agent inline), or generate an execution plan via an adapter (Claude Tasks, Relay, Markdown, GitHub Issues) and let the external orchestrator drive. Updates step status during execution; never writes `audit.result` or `status=verified`.
user-invocable: false
---

# Run: Steps -> Execution

Take a feature from plan to execution. Two paths depending on what's
appropriate for the project:

| Path                  | When                                                                                                       |
|-----------------------|------------------------------------------------------------------------------------------------------------|
| **Polyglot run**      | Single-agent flow on a portable artifact. The `.tend.html` is its own orchestrator: `bash <file> run` iterates `steps[]` and invokes the agent CLI per step, then runs smoke. |
| **External adapter**  | Multi-agent or external orchestrator. `tend_output_execution_plan` emits the plan in the adapter's native format (Claude Tasks bundle, Relay workflow, Markdown spec, GitHub Issues batch); the orchestrator consumes it. |

This skill never writes `audit.result` or `status = "verified"` - that
belongs to `tend-audit`, which evaluates the evidence before the verdict.
Run finishes the implementation; audit determines whether it's actually
done.

## What this skill assumes

- The feature has steps written (output of `/tend plan`). Each step's `Test:` block has been authored.
- Each step traces to specific check IDs via `traces_to`. Untraced steps must be command/worktree steps (no test discipline applies).
- For steps tracing to checks with `validates_job` set, the bound persona-job's `validation` clause is available to inject into the agent's RED prompt — the failing test asserts against that validation, not a paraphrase.
- An execution adapter is configured (`docs/tend/adapters/*.json`) or the user has chosen one for this run.

## Fits the whole

| Layer            | Role                                                                       |
|------------------|----------------------------------------------------------------------------|
| Polyglot         | `bash <file>.tend.html run` orchestrates the build; `bash <file>.tend.html smoke` verifies |
| MCP              | `tend_output_execution_plan` emits adapter-native plans; `tend_update_feature` writes step status during run |
| Filesystem       | Reads feature data via `bash <file> data | jq`; the polyglot is the source |

## Rules

- If `steps[]` is missing or empty, stop and tell the user to run `/tend plan` first.
- Respect step `dependencies`: never start a step until all the steps it lists in `dependencies` are `done`. Flag blocked steps clearly.
- Track status via `tend_update_feature`, merging step updates by `id`: set `in-progress` when starting, `done` or `failed` on completion. The MCP write recomputes `progress.implementation` automatically.
- On failure: stop unless the feature's `agent_hint.error_strategy` (or step-level override) is `skip`. Never silently skip a failed step on `fail` strategy.
- Resume from the first non-`done` step if any are already `done` from a prior run.
- **Never set `status = "verified"`** - only `tend-audit` does that, and only when `audit.result === 'pass'`.
- **End by recommending `/tend audit`.** All-steps-done is not the same as feature-works. The truth gap closes at audit, not at run.
- **Log progress**: when updating step status, include a `log` entry — an array of `{ at, type, text }` objects on the step. Entries append across calls (each `tend_update_feature` adds to the journal rather than replacing it), so log incrementally. Types: `note` (what was done), `discovery` (something found during work), `blocker` (something preventing progress), `decision` (a choice made during implementation), `error` (a failure encountered).
- **Test-first per step**: every agent step that has `traces_to` runs PRE -> RED -> IMPL -> GREEN -> POST -> VERIFY -> DOC. RED writes the failing test from the step's `Test:` block (in `description`). IMPL makes the test pass and is constrained NOT to modify the test file. GREEN re-runs the test and verifies it passes. Command and worktree steps skip RED/GREEN (exit code is the test). Steps without `traces_to` skip RED/GREEN (typically setup steps, not check-driven feature work).
- **RED passing is an alarm.** If the test passes immediately when RED runs it, the check is already implemented or the test is wrong. Stop. Surface to the user. Do not proceed to IMPL silently.
- **IMPL never modifies the test file.** The constraint is a hard rule in the IMPL prompt. If the test is wrong, stop and fix the test as a separate concern (probably the recipe was off - back to brainstorm or plan).
- **VERIFY tasks check the checks the step traces to**, with file:line evidence.
- **Mocks of the unit under test are zero evidence.** A test that asserts on a `vi.fn()` return value the check is about does not prove the check. VERIFY must reject this kind of evidence and demand a real test.
- **External adapter path**: every IMPL task has a POST review task and a VERIFY task. No IMPL without POST + VERIFY.
- **External adapter path**: task prompts must be self-contained - include feature id, step id, file paths, traced check ids and text, and `integration_level` callouts. Adapters receive no shared conversation context.
- **POST: record actual files touched in coverage_files.** After IMPL + GREEN succeed, call `tend_update_feature({ id, changes: { coverage_files: [...existing, ...newly_touched] } })` appending every source file created or modified in this step. Omit test files and fixtures. Use append semantics — never replace the existing list.

## Workflow

### -1. Read drift_verdict

Before generating any plan or invoking the agent, read `drift_verdict` from `tend validate`. If it's `broken-refs`, fix the graph first (`tend_update_feature` to repair the named cross-ref) — running steps against a broken graph poisons every downstream artifact. If it's `stale-evidence` or `narrative-cite-stale`, hand off to `/tend audit` on the named feature before running; you're about to add to a stack of unverified work.

### 0. Load the feature

```bash
bash docs/tend/features/<id>.tend.html data | jq
```

Confirm `steps[]` is present and non-empty. Note the feature's
`agent_hint.error_strategy` if present (`fail` is default, `skip`
continues past failures). Note `smoke.cmd` if present - the final
verification will run it.

### 0.5. Smoke pre-flight — halt on the missing end-to-end gate

Before choosing a path, check the smoke gate. If **both** are true —
`smoke.cmd` is absent **AND** no `decisions[]` entry explains why this
feature has no smoke — **HALT and surface the gap.** A feature with no
end-to-end check and no logged reason can't prove it works as a whole; the
run would finish "all steps done" with nothing tying them together.

```bash
bash docs/tend/features/<id>.tend.html data | jq '{smoke: .smoke.cmd, decisions: [.decisions[]?.decision]}'
```

If `smoke.cmd` is null/empty and no decision mentions smoke / no-smoke /
"pure library" rationale:

> "This feature has no `smoke.cmd` and no logged decision explaining its
> absence. Running it now would leave the bet without an end-to-end
> verification. Recommended: run `/tend brainstorm <id>` to add a
> `smoke.cmd`, or to log a `decisions[]` entry stating why none applies
> (e.g. a pure library with only unit-testable APIs). Add one of those,
> then re-run `/tend run`. Want to proceed without smoke anyway?"

Only continue past this gate on explicit user direction. If `smoke.cmd`
exists, or a decision already explains its absence, proceed silently.

### 1. Choose path

```
how do you want to execute <id>?

  bash run       — bash <file>.tend.html run (single agent inline)
  claude-tasks   — generate Claude Tasks bundle, run via the task runner
  relay          — generate Relay workflow (parallel DAG, multi-agent)
  markdown       — emit a markdown spec for a human or external tool
  github-issues  — open issues for each step (batch)
```

If the user picks `bash run`, follow [Path A](#path-a-polyglot-bash-run).
Otherwise follow [Path B](#path-b-external-adapter).

---

## Path A: polyglot bash run

The simplest path. The `.tend.html` is the orchestrator. The bash `run`
verb iterates `steps[]`, invokes the agent CLI per step, then runs
smoke. No external system needed.

### A1. Prepare

Set the agent command (resolution order: `oo-data.execute.agent_cmd` ->
env `TEND_AGENT_CMD` -> default `claude -p`). For example:

```bash
export TEND_AGENT_CMD="claude -p"
```

### A2. Run

```bash
bash docs/tend/features/<id>.tend.html run
```

The verb does this for each step in order:

1. Update step status to `in-progress` (via `tend_update_feature` if MCP is reachable).
2. For agent steps with `traces_to`: pipe the `Test:` block prompt to the agent (RED). Then pipe the IMPL prompt with the don't-modify-test constraint. Then re-run the test (GREEN).
3. For command/worktree steps: execute the command; exit code is the verdict.
4. On non-zero exit: halt the run, mark the step `failed`, abort smoke.
5. After all steps succeed: run `bash <file>.tend.html smoke`.

The bash dispatcher reads `oo-data.smoke.cmd` and runs it. Smoke pass
means the workflow is complete (but verified status still requires
`/tend audit`).

### A3. After the run

Read the final state:

```bash
bash docs/tend/features/<id>.tend.html status
```

Report and recommend audit (see [Step 3: report and recommend audit](#step-3-report-and-recommend-audit)).

---

## Path B: external adapter

When the project needs multi-agent parallelism, persistent task tracking,
or integration with an external orchestrator, use an adapter to *emit*
the plan in a native format and let the external system drive.

### B1. Generate the plan

```
tend_output_execution_plan({
  feature_id: "<id>",
  adapter: "claude-tasks" | "relay" | "markdown" | "github-issues"
})
```

Writes output files to `docs/tend/output/<adapter>/<id>.<ext>`.

What each adapter emits:

- **claude-tasks**: per agent step with `traces_to`, a PRE/RED/IMPL/GREEN/POST/VERIFY/DOC task hierarchy. Per scope, a CHECKPOINT task. One final VERIFY-FEATURE task (depends on the last DOC) that goes through every check and demands evidence; runs `smoke.cmd` if defined. Output: a Claude Tasks bundle.
- **relay**: a `.ts` workflow file. For each agent step with `traces_to`: a `<id>:test` step (write failing test) then `<id>:impl` (depends on `:test`, IMPL prompt includes don't-modify-test). Command/worktree steps emit a single step. Per-scope verification gates. Final `smoke-test` step (if `smoke.cmd` is set) that depends on every preceding step.
- **markdown**: a human-readable spec a person or external tool can follow.
- **github-issues**: one issue per step, with links between parent/child for dependencies.

### B2. Run the plan

For Relay:

```bash
npx tsx docs/tend/output/relay/<id>.ts
```

For Claude Tasks: the bundle is consumed by the Claude Code task runner;
follow Claude Tasks docs.

For Markdown / GitHub Issues: the orchestrator (or a human) drives.

As the orchestrator reports step lifecycle events:

- Step start -> `tend_update_feature` merging `steps: [{ id, status: "in-progress", log: [{ at, type: "note", text: "started" }] }]`.
- Step complete -> `tend_update_feature` with `status: "done"` and any `artifacts`.
- Step failure -> `tend_update_feature` with `status: "failed"` and a `log` entry of type `blocker` or `error`. Halt unless `error_strategy` is `skip`.

The smoke-test step's pass/fail is the final gate. Treat its failure as
the workflow failing even if all upstream steps pass.

---

## Step 3: report and recommend audit

After execution ends (complete, stopped, or failed), read the state:

```bash
bash docs/tend/features/<id>.tend.html data | jq '.steps, .progress, .smoke'
```

`progress` was auto-recomputed by the MCP writes; no manual recompute
call is needed.

Report step results:

```
run: <id>  path: <bash | adapter-name>
───────────────────────────────────────────
  v  i001  done
  v  i002  done
  x  i003  failed
  .  i004  pending (depends: i003)

stopped: i003 failed
  error: <error summary>

implementation: <N>%
verification:   <N>% (audit not yet run)
───────────────────────────────────────────
```

**Always end with the audit recommendation:**

```
All steps complete (implementation: 100%). Checks are not yet verified -
the feature is "in-progress", not "verified". Run:

    /tend audit <id>

to evaluate evidence per check, run the smoke test (if any), and decide
whether the feature can transition to verified.
```

If the run finished with verification < implementation (or no audit at
all), surface the warning prominently. That's the suspicious "false done"
state: claims of completion without verification.

## Done When

- The path was chosen (bash run vs adapter) and run.
- **Bash run**: every step in `steps[]` either executed (status updated to `done`/`failed`/`skipped`) or was skipped because its dependency failed. Smoke ran if all steps succeeded.
- **External adapter**: `tend_output_execution_plan` was called; the orchestrator ran the resulting plan; step lifecycle events were mapped to `tend_update_feature` writes.
- Each step's status is recorded; `progress.implementation` reflects steps done.
- A summary of step results is reported.
- The user is explicitly told to run `/tend audit <id>` before considering the feature done.
- `status` is unchanged unless transition from `planned` -> `in-progress` was triggered by the first step starting. Never `verified`.

## Next move

Close the loop — don't leave the user guessing what comes next.

1. **Compute it.** Call `tend_get_next` (MCP preferred; CLI fallback
   `node dist/bin/tend.js next --json`). It reads on-disk state and
   returns the highest-leverage action with reason codes.
2. **Present it plainly.** State the recommended `action` verbatim and the
   reason in plain words (paraphrase the reason code, don't paste it).
   After a completed run the recommendation is almost always
   `/tend audit <id>` — *"all steps are done but no audit has run, so the
   bet is implemented-not-verified."*
3. **Offer to chain — never auto-execute.** Ask before continuing:
   *"Want me to run `/tend audit <id>` now?"* Only proceed on the user's
   yes. Run never sets `status = verified`; only `/tend audit` can.

All-steps-done is not feature-works. Let `tend_get_next` confirm the audit
move rather than assuming the run is the finish line.
