# Codex hooks do not fire in linked git worktrees — root cause & fix

## Symptom

A `codex` worker spawned in a **linked git worktree** (`git worktree add`) never
fires its `Stop` hook. `events/stop` never advances, so `umbel wait` hangs to the
timeout (the original "stuck worker" — `pl-c8f14ad8` in the pleach proof). Plain
dirs and the main checkout are unaffected.

## Root cause (empirically confirmed, codex 0.133.0)

**Codex refuses to run *project-level* `.codex/hooks.json` hooks inside a linked
worktree.** A linked worktree's `.git` is a *file* (`gitdir: <main>/.git/worktrees/<name>`);
codex detects this and treats the worktree as a subdirectory of the repo whose
root is `<main>`. Project-hook loading is then suppressed in a way that **no
launch-side configuration can override**.

Verified by elimination — in a worktree, the `Stop` hook does **not** fire for any of:

| hooks.json location | dir trust | `--dangerously-bypass-hook-trust` | clean `CODEX_HOME` | Stop fires? |
|---|---|---|---|---|
| `<wt>/.codex/`       | trusted | no  | no  | ❌ |
| `<main>/.codex/`     | trusted | no  | no  | ❌ |
| `<main>/.codex/`     | trusted | **yes** | no  | ❌ |
| `<main>/.codex/`     | trusted | **yes** | **yes** | ❌ |

The pane shows the turn completing (`• ready`) every time — the model runs, the
hook just never executes. A plain (non-worktree) dir with the *same* umbel config
fires `Stop` and auto-persists `[hooks.state."<dir>/.codex/hooks.json:stop:0:0"]`.

### Why the earlier hypotheses were wrong
- **CODEX_HOME relocates auth** → would break login. (Rejected before baking.)
- **"Redirect hooks to `<main>/.codex/`"** → codex *does* resolve worktree hook
  discovery to `<main>` (proved: a `[hooks.state."…/main/.codex/hooks.json:stop:0:0"]`
  entry is written keyed on main), but it still won't *run* them. Necessary-looking,
  not sufficient.
- **Hook-trust via `--dangerously-bypass-hook-trust`** → the flag runs *enabled*
  hooks without persisted trust, but worktree project-hooks are never *enabled*, so
  the flag is a no-op here.

## The fix (validated end-to-end through umbel)

**Codex *does* load and run a global `$CODEX_HOME/hooks.json` inside a worktree.**
So deliver umbel's codex hooks via a **shared umbel-managed `CODEX_HOME`** instead
of the project `.codex/`:

```
$UMBEL_STATE/codex-home/
├─ auth.json     → symlink to <user CODEX_HOME>/auth.json   (no secret copy; shared token refresh)
├─ config.toml     copied once from the user's (carries model/endpoint/MCP); codex appends its own [projects]/[hooks.state] trust here, isolated from the user's real config
└─ hooks.json      umbel's Stop + PermissionRequest hooks (today's content, verbatim)
```

- Worker env gets `CODEX_HOME=$UMBEL_STATE/codex-home`.
- umbel's **existing** startup dialogs (`trust the contents…` → Enter, `hooks need
  review` → "Trust all and continue") trust it on first use; persisted, so later
  spawns fast-path.
- **Stop fires in worktrees AND plain dirs** → one uniform mechanism.

Validated: `spawn --provider codex --cwd <wt> --env CODEX_HOME=<umbel-home>` →
`send` → `events/stop` written, `transcript-path` captured, `wait` settles `stop`.

### Bonus
Eliminates the known hazard of umbel overwriting a user's `<cwd>/.codex/hooks.json`,
and matches the architecture-v3 §"v4 plan is CODEX_HOME-style out-of-cwd config."

## Implementation (as built)

- **Spec** (`core/providers/types.ts`): `ProviderLaunchSpec.files[]` is a union —
  `{content}` | `{symlinkTo}` | `{copyFrom, ifAbsent?}`, each with optional `shared`.
  `buildLaunch` stays pure (declares intent); spawn's `materializeFile` performs the
  write/symlink/copy at the I/O edge (symlink/copy are idempotent so the shared home
  is safely re-materialized by every worker).
- **Codex provider** (`core/providers/codex.ts`): `buildLaunch` emits
  `env.CODEX_HOME = <stateDir>/codex-home` plus three `shared` files there —
  `hooks.json` (content), `auth.json` (`symlinkTo` the user's CODEX_HOME), `config.toml`
  (`copyFrom` ifAbsent). No more `<cwd>/.codex/hooks.json`. spawn injects `stateDir`
  and `userCodexHome` (= `$CODEX_HOME ?? ~/.codex`).
- **Reserved env** (`operations/spawn.ts`): the worker's `CODEX_HOME` is applied as
  reserved provider launch env (after operational + `--env`), so umbel always owns it
  — a stray `--env CODEX_HOME` can't silently re-break worktree hooks.
- **Shared-infra semantics**: `shared` files are set up idempotently, NOT recorded in
  `meta.providerFiles`, NOT removed on kill (other live workers depend on them).
- **Tests**: codex unit (`buildLaunch` → codex-home shape), codex integration
  (symlink/copy/shared lifecycle against an isolated fake user-CODEX_HOME), the
  reserved-env precedence test, and the gated real-binary worktree + plain codex
  smokes — all green.

## Decision log
- **2026-06-13** — Codex worktree project-hooks are unrunnable; umbel delivers codex
  hooks via a shared `$UMBEL_STATE/codex-home` (global `hooks.json` + symlinked
  `auth.json`). Supersedes the project-level `<cwd>/.codex/hooks.json` mechanism for
  codex. Auth is symlinked (not copied); trust handled by existing startup dialogs.
