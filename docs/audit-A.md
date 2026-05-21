# Audit A — core + adapters

Inline audit conducted after subagent delivery. **All 185 tests pass, typecheck clean, lint clean, no leaked tmux sessions.**

## S.U.P.E.R. compliance ✅

- **S** (Side effects at edge): all I/O is in adapters. Core has zero `fs`, `process.env`, `Date.now()`.
- **U** (Uncoupled): every adapter takes `env` as a parameter; no module globals.
- **P** (Pure & total): typed errors thrown at boundaries; no unhandled cases.
- **E** (Explicit data flow): args in → results out; no mutation chains.
- **R** (Replaceable): functions are referentially transparent given their inputs.

## Type safety ✅

- No `any` in `src/`.
- No `@ts-ignore` or `eslint-disable`.
- `noUncheckedIndexedAccess` enforced.
- Branded `SessionName` flows through schema validation.

## Findings + fixes

### F1: `killSession` TOCTOU — **FIX APPLIED**

`adapters/tmux.ts:killSession` calls `hasSession` then `kill-session`. Between the two, the session could be killed by another process, causing `kill-session` to throw `TmuxError`. Truly idempotent kill should swallow "no such session" errors.

**Fix:** call `kill-session` directly; suppress errors matching `/can't find session|no current session|session not found/i`.

### F2: Dynamic import in `jsonl.ts` — **FIX APPLIED**

`discoverSessionJsonl` had `const { readdir } = await import('node:fs/promises')` inside a hot loop. No reason for dynamic import. Moved to top-of-file static import.

### F3: `as string` cast in `jsonl.ts` — **FIX APPLIED**

`return found[0] as string` masks the `string | undefined` from `noUncheckedIndexedAccess`. Replaced with explicit guard.

### F4: `birthtimeMs` reliability — **FIX APPLIED**

Some Linux filesystems return `birthtimeMs === 0` for files. macOS APFS is fine, but for portability, fall back to `mtimeMs` when birthtime is zero.

### F5: `rmSession` is filesystem-only — **NOT A BUG, NOTED**

`rmSession` only removes state dir; tmux session is not killed. This is correct layering — `kill()` operation in `operations/` calls both `tmuxKill` + `rmSession`. Documented in audit.

### F6: `ensureGlobalHooks` not atomic against concurrent install — **DEFERRED**

If two rctrl invocations both hit first-run installation simultaneously, the writes could interleave. Low probability (one-time setup); acceptable for v1.

### F7: fake-claude's python3 dependency — **NOTED**

`fake-claude.sh` uses `python3` for JSON escaping. Fine on macOS (preinstalled) and most Linux. Documented as test-only.

## Not changed

- `writeMeta` temp-name uses `Date.now()` without random suffix. Since architecture says sessions are owned by one rctrl invocation per turn, concurrent writes to same session don't happen. Acceptable.
- `fs-watch.ts` uses `undefined as unknown as WatchEvent` casts for the done-iteration case. Required by TS strict typing of `IteratorResult<T>` and idiomatic for async iterator protocol.

## Status

After fixes: still 185/185 tests pass, typecheck + lint clean.
