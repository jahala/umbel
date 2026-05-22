# Audit C — multi-CLI race conditions, cleanup paths, error handling

Post-v3 audit (after #32 through #39 landed). Focus: the new provider-files lifecycle and the new error class.

432 tests pass, typecheck clean. The findings below are about *correctness under failure*, not green-path behavior.

## Findings + fixes

### F1: spawn leaks provider files when `tmux.newSession` fails — **FIX APPLIED**

`src/operations/spawn.ts` writes `<cwd>/.codex/hooks.json` (Codex) or `<cwd>/.gemini/settings.json` (Gemini) BEFORE calling `tmux.newSession`. If tmux fails (binary missing, session-name collision, etc.) the catch block kills tmux + rms session state but does NOT remove the provider file we wrote.

Result: stale `.codex/hooks.json` left in user's project directory after a failed spawn. On next legitimate codex run by the user, our hook fires and writes to a session dir that no longer exists → `stop.sh` errors → cycle.

**Fix:** the catch blocks now unlink `providerFilePaths[]` before re-throwing.

### F2: spawn leaks provider files when `writeMeta` fails — **FIX APPLIED**

Same issue, separate catch path. tmux is alive at this point so we also kill it. Now also unlinks providerFilePaths.

### F3: partial provider file write isn't rolled back — **FIX APPLIED**

The `for (const f of launchSpec.files)` loop pushes to `providerFilePaths` AFTER `writeFile`. If `writeFile` throws on the Nth file, files 0..N-1 are written but the array only records 0..N-1. The current catch block wasn't reached because the throw bypassed it. Fixed by wrapping the write loop in a try and unlinking on failure.

### F4: `ProviderUnknownError` doesn't map to exit 2 — **FIX APPLIED**

`src/faces/cli.ts:errorExitCode` didn't list `ProviderUnknownError`, so `rctrl spawn --provider bogus` would exit 1 (generic) instead of 2 (usage). It's a user input error → exit 2. Now mapped explicitly.

## Documented (deferred to v4)

### V1: silent overwrite of user's existing provider config files

`<cwd>/.codex/hooks.json` and `<cwd>/.gemini/settings.json` are write-blindly. If the user has their own hooks/settings, rctrl clobbers them on spawn and restores nothing on kill (because kill just unlinks our copy, not the user's original).

`gemini.ts` has an inline comment noting this; `codex.ts` does not. Real fix is option (a) or (b):

- (a) **Detect-and-abort**: if file exists with different content, fail spawn with a clear error pointing the user at `--config-merge` (unimplemented) or telling them to remove the file.
- (b) **Out-of-cwd config**: write to `$RCTRL_STATE/sessions/<name>/.codex/hooks.json` and set `CODEX_HOME` env to point Codex at that dir. Cleaner — no cwd pollution, no collision risk. Gemini may or may not have an equivalent env var (need research; `GEMINI_HOME`/`GEMINI_CONFIG_DIR`?).

Option (b) is the right v4 direction. Option (a) is a stopgap.

### V2: multi-session same-cwd kill race

Two rctrl sessions A and B both targeting Codex in the same cwd write the SAME `<cwd>/.codex/hooks.json`. When A is killed, it unlinks that file. B's next prompt then fires no hook (config gone) and the wait for B's Stop times out.

`meta.providerFiles` records the path per-session without coordination. Two fixes:

- Same as V1.(b) above — per-session config dirs via `CODEX_HOME` / equivalent. Sidesteps the collision entirely.
- Failing that, reference-counting via a sidecar file at `<cwd>/.codex/.rctrl-refs` listing session names that depend on the hooks.json — unlink only when the last ref disappears. More complex; not worth it if (b) is feasible.

Caught by code review, not by a test. The integration tests use isolated `mkdtemp` cwds per test so they don't surface it. Worth adding a test in v4: spawn two codex sessions in the same cwd, kill one, verify the other still has a hook config.

## Non-issues (verified safe)

- **TOCTOU between readMeta and unlink in `kill`**: kill reads meta to get `providerFiles[]`, then unlinks. Another process could replace the file between read and unlink. We `.catch(() => undefined)` the unlink, so even a missing file is silent. Safe.
- **`removeState: false` kill skips provider file cleanup**: intentional. `--keep-state` means "I want to leave the session dir intact for inspection." Provider files are part of the session's filesystem footprint and should be kept too. Documented.
- **Provider lookup miss surfaces deep in spawn**: `getProvider('bogus')` throws `ProviderUnknownError` from inside spawn → cli.ts errorExitCode (post-F4 fix) → exit 2 with message. Good.

## Status

After F1–F4 applied: 432 tests still pass, typecheck clean, lint baseline (11 pre-existing warnings on `!` assertions in gemini tests — out of audit-C scope).
