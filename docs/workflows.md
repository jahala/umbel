# rctrl Workflow Guide

A workflow YAML file lets you declare a set of agent sessions (workers) and a sequence of prompts to send them, with dependencies and output capture. `rctrl run` executes the file, handles topological ordering, and tears everything down on exit. Each worker can use a different provider — claude, codex, or gemini — in the same run.

For the schema source, see `src/core/types.ts` (`WorkflowSpecSchema`, `WorkflowStepSchema`, `WorkerSpecSchema`, `OutputSpecSchema`, `WaitConditionSchema`).

---

## Quickstart

```yaml
workers:
  assistant:
    cwd: .

steps:
  - run: assistant
    prompt: List the five largest files in this directory.
    outputs:
      result: assistant_last_message
```

Run it:

```bash
rctrl run example.yaml
```

The output is captured to `~/.rctrl/workflows/<run-id>/outputs/assistant/result`.

---

## Schema

### Top level

```yaml
workers:
  <name>: <WorkerSpec>

steps:
  - <WorkflowStep>
  - <WorkflowStep>
  ...
```

Both keys are required. `steps` must contain at least one entry.

Worker names and step `run:` values must be valid session names: `^[a-z0-9][a-z0-9-]{0,62}$`.

---

### WorkerSpec

Declared under `workers:`. Specifies how a session is spawned.

```yaml
workers:
  reviewer:
    cwd: ./worktrees/review      # required; must exist before rctrl run
    provider: claude             # optional: claude | codex | gemini (default: claude)
    model: sonnet                # optional: free-form; the provider validates at spawn time
    allowedTools: "Read,Bash"   # optional; forwarded to the provider's equivalent flag
```

| Field | Required | Description |
|-------|----------|-------------|
| `cwd` | yes | Working directory for the session. rctrl does not create worktrees; use `git worktree add` first. |
| `provider` | no | Which CLI to launch. One of `claude`, `codex`, `gemini`. Defaults to `claude` — existing v2 YAML files work without changes. |
| `model` | no | Free-form model string. Each provider validates its own model names at spawn time; the YAML schema does not restrict values. |
| `allowedTools` | no | Comma-separated tool list. Mirrors `rctrl spawn --allowed-tools`. |

---

### WorkflowStep

Each entry in `steps:`.

```yaml
steps:
  - run: reviewer                      # required: which worker to use
    prompt: |                          # required: prompt text (supports {{ }} substitution)
      Review the PR.
    wait:                              # optional: wait condition (defaults shown below)
      stop: $session
    outputs:                           # optional: capture outputs after the step
      review: file:./review.md
    needs:                             # optional: steps that must complete first
      - prior-step-worker
```

| Field | Required | Description |
|-------|----------|-------------|
| `run` | yes | Name of a worker declared in `workers:`. |
| `prompt` | yes | Prompt text. Supports `{{ }}` substitution (see Templating). |
| `wait` | no | Wait condition. Defaults to `{ any: [{ stop: $session }, { timeout: 30m }] }`. |
| `outputs` | no | Map of output key to OutputSpec. Captured after wait resolves. |
| `needs` | no | List of worker names whose steps must complete before this step starts. |

---

## Wait conditions

Defined as `WaitCondition` in `src/core/types.ts:35-41`. Conditions compose with `all` and `any`.

### stop

Wait for the session's Stop hook to fire (end of turn). This is the primary and most reliable condition.

```yaml
wait:
  kind: stop
  session: reviewer
  sinceMtime: 0        # set automatically by the workflow executor; omit in YAML
```

In practice, you write `stop: $session` as shorthand (the executor expands `$session` to the current worker name):

```yaml
wait:
  stop: $session
```

### file

Wait for a path to exist on disk.

```yaml
wait:
  kind: file
  path: ./worktrees/fix/tests-passed
```

### pattern

Wait for a line in the session's tmux pane to match a regex.

```yaml
wait:
  kind: pattern
  session: reviewer
  regex: "All checks passed"
```

### timeout

Wait for a fixed duration. On its own, this causes a step to fail with exit code 124. Typically used inside `any` as a ceiling.

```yaml
wait:
  kind: timeout
  ms: 600000          # 10 minutes in milliseconds
```

### all

Wait until every listed sub-condition is satisfied.

```yaml
wait:
  kind: all
  conditions:
    - { kind: stop, session: fixer }
    - { kind: file, path: ./worktrees/fix/tests-passed }
```

### any

Wait until any listed sub-condition is satisfied. The most common pattern is pairing `stop` with a `timeout` ceiling:

```yaml
wait:
  kind: any
  conditions:
    - { kind: stop, session: reviewer }
    - { kind: timeout, ms: 600000 }
```

### Default wait

If `wait:` is omitted from a step, the executor applies:

```
{ any: [{ stop: $session }, { timeout: 1800000 }] }
```

(30-minute ceiling). No step waits forever.

---

## Output capture

Declared in `outputs:` as a map from a key name to an OutputSpec (`src/core/types.ts:90-93`).

Two forms:

### file:./path

Read the contents of a file after the step completes. The path is resolved relative to the workflow file's directory.

```yaml
outputs:
  review: file:./worktrees/review/review.md
```

### assistant_last_message

Read the last assistant message from the session's JSONL log. Equivalent to `rctrl read <name>`.

```yaml
outputs:
  summary: assistant_last_message
```

Captured outputs are written to `~/.rctrl/workflows/<run-id>/outputs/<worker-name>/<key>` and are available for substitution in downstream steps via `{{ steps.NAME.outputs.KEY }}`.

---

## Templating

Prompt strings support `{{ }}` substitution. The template engine is intentionally minimal: variable substitution only. No expressions, no conditionals, no loops. If you need control flow, write a shell script that calls `rctrl`.

### Available variables

| Variable | Resolves to |
|----------|------------|
| `{{ env.X }}` | The environment variable `X` at the time `rctrl run` is invoked. |
| `{{ steps.NAME.outputs.KEY }}` | The captured output `KEY` from the step that ran on worker `NAME`. Only available in steps that declare `needs: [NAME]` or run after `NAME` in topological order. |
| `{{ $session }}` | The name of the current step's worker. Used primarily in `wait:` blocks. |

### What is not supported

- Arithmetic or string expressions (`{{ env.X + 1 }}`)
- Conditional blocks (`{% if %}`)
- Loops or iteration
- Filters or pipes

If an unresolved variable is referenced at runtime, the executor substitutes an empty string and logs a warning.

---

## Parallelism and the `needs:` field

Steps are sorted topologically by their `needs:` declarations. Steps with no unsatisfied dependencies run in parallel.

```yaml
workers:
  reviewer: { cwd: ./worktrees/review }
  fixer: { cwd: ./worktrees/fix }
  tester: { cwd: ./worktrees/test }

steps:
  - run: reviewer           # wave 1: no dependencies
    prompt: Review the PR.
    outputs:
      findings: assistant_last_message

  - run: fixer              # wave 2: depends on reviewer
    needs: [reviewer]
    prompt: |
      Apply these fixes:
      {{ steps.reviewer.outputs.findings }}

  - run: tester             # wave 2 also: depends on reviewer, not on fixer
    needs: [reviewer]
    prompt: |
      Write tests for the issues found:
      {{ steps.reviewer.outputs.findings }}
```

Wave 1 runs first. Wave 2 runs both `fixer` and `tester` concurrently once `reviewer` finishes.

Cycles in `needs:` are detected at parse time and cause a `WorkflowCycleError` (exit code 1).

---

## Session lifecycle in workflows

Each step spawns or reuses the session for its declared worker. Workers persist across steps within a single `rctrl run` invocation:

1. `rctrl run` reads the YAML and validates it against `WorkflowSpecSchema`.
2. Workers are spawned (one tmux session per worker name).
3. Steps execute in dependency-wave order. Within a wave, steps run concurrently.
4. Each step: sends prompt, waits for condition, captures outputs.
5. On completion (success or failure), all worker sessions are killed and state is cleaned up.

Workers are not shared between separate `rctrl run` invocations.

---

## State on disk

Each `rctrl run` generates a run ID and persists state at:

```
~/.rctrl/workflows/<run-id>/
  workflow.yaml          copy of the input file
  status.json            current run status
  outputs/<worker>/<key> captured output files
```

Override the base directory with `$RCTRL_STATE`.

---

## A realistic example

Three-step pipeline: review a PR with claude, apply fixes with codex, verify with claude. Different steps in the same workflow can use different providers; the provider is declared per-worker and looked up from `meta.json` for the lifetime of the run.

```yaml
workers:
  reviewer:
    cwd: ./worktrees/review
    provider: claude
    model: sonnet
  fixer:
    cwd: ./worktrees/fix
    provider: codex
    model: o4-mini
    allowedTools: "Read,Edit,Bash"

steps:
  - run: reviewer
    prompt: |
      Review PR #{{ env.PR_NUMBER }}.
      Write your findings to review.md.
      Be specific: list file paths, line numbers, and the required change for each issue.
    wait:
      kind: any
      conditions:
        - { kind: stop, session: reviewer }
        - { kind: timeout, ms: 600000 }
    outputs:
      findings: file:./worktrees/review/review.md

  - run: fixer
    needs: [reviewer]
    prompt: |
      Apply the following fixes exactly as described.
      Do not change anything not listed.

      {{ steps.reviewer.outputs.findings }}
    wait:
      kind: all
      conditions:
        - { kind: stop, session: fixer }
        - { kind: file, path: ./worktrees/fix/.fix-complete }
    outputs:
      summary: assistant_last_message

  - run: reviewer
    needs: [fixer]
    prompt: |
      The fixes have been applied. Verify them against your original review.
      Write LGTM to review-final.md if everything is resolved, or list remaining issues.
    outputs:
      verdict: file:./worktrees/review/review-final.md
```

Run with:

```bash
PR_NUMBER=42 rctrl run pr-pipeline.yaml
```
