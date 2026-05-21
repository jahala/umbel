# Audit B — race conditions, TOCTOU, state issues, error paths

Inline audit of operations + faces layers. 238 tests pass, types and lint clean. Findings + fixes below.

## Critical findings + fixes

### B1: Leaked external signal listener in `wait.ts` — **FIX APPLIED**

`wait.ts` registers TWO listeners on `opts.signal`:
1. Line 89-93: `externalAbortHandler` forwards to internal abort. **This one IS removed** in cleanup (line 206).
2. Lines 279-283: A second listener calls `settle({ reason: 'aborted' })` directly. **This one is NEVER removed.**

Result: every `waitFor` call that completes without external abort leaks one listener on the external signal. For long-lived signals reused across many waits, this accumulates.

**Fix:** the second listener is redundant — the internal abort flow handles aborted external signals correctly. Remove lines 279-283 and rely on the internal abort listener that already settles with `'aborted'` reason.

### B2: `spawn.ts` doesn't clean up if `writeMeta` fails — **FIX APPLIED**

If `writeMeta` (line 115) throws after a successful tmux spawn + JSONL discovery, the tmux session and state dir are left alive but the caller gets an error. Subsequent `rctrl ls` would show a session without meta.

**Fix:** Wrap `writeMeta` in try/catch with the same best-effort cleanup pattern used earlier in the function.

### B3: `runP` leaks anonymous sessions on send/wait failure — **FIX APPLIED**

After successful spawn, if `send()` or `waitFor()` throws (e.g. SessionDeadError, TmuxError), the anonymous session is **not** killed. State dir + tmux session both leak.

The two existing cleanup branches (`waitResult.reason === 'aborted'` and `=== 'timeout'`) only handle the wait-success-but-bad-reason cases, not actual thrown errors.

**Fix:** Wrap the send + wait + read flow in try/catch; on any throw, kill the anonymous session before rethrowing.

### B4: TOCTOU in spawn between `ensureGlobalHooks` and `tmux.newSession` — **NOT FIXED**

If another process deletes the global hook script between install and use, claude starts without a working hook. Probability vanishingly low (global hook is a stable, idempotent file). Acceptable risk for v1.

## Non-issues (verified safe)

- **wait.ts initial check vs watcher setup race**: chokidar subscription is synchronous before `check()` can await anything. No race.
- **wait.ts pattern + stop combined**: pattern polls every 500ms, stop events via fs.watch. Both call `check()`. No interleaving issue (JS single-threaded).
- **workflow.ts activeSessions array**: push/splice from "parallel" async tasks is safe because JS is single-threaded between awaits, and `indexOf` always returns the current index in the current array.
- **paneText swallows TmuxError**: dead-session capture returns `''` — predicate just doesn't match, wait times out cleanly. Documented behavior, not a bug.
- **Named session not killed on timeout in `runP`**: intentional — named sessions persist by design.

## Watch items (v2)

- Signal abort during spawn: spawn does not honor an external signal — if user ctrl-Cs while claude is booting (5s window), it completes anyway. Minor UX issue. Track for v2.
- `runP` JSONL read failure leaks anonymous session — covered by B3 fix.

## Status

After applying B1, B2, B3: all 238 tests still pass, lint and typecheck clean.
