# Adapters Layer — Implementation Summary

## Files Created

### Implementations (`src/adapters/`)

| File | LOC | Description |
|------|-----|-------------|
| `tmux.ts` | 139 | Wraps tmux CLI. Auto-prefixes sessions with `rctrl-`. Routes send via `send-keys -l` (short) or `load-buffer + paste-buffer` (multi-line / >1000 chars). Unique buffer names per send prevent concurrent collisions. |
| `fs-state.ts` | 106 | Manages `$RCTRL_STATE/sessions/<name>/`. All functions take `env` explicitly — no `process.env` reads. `writeMeta` is atomic (temp-then-rename). `listSessionNames` returns sorted results. |
| `hooks.ts` | 69 | Exports `STOP_HOOK_SCRIPT` constant, `buildSettingsJson` (Claude Code `--settings` inline JSON with Stop hook + optional permissions), and `ensureGlobalHooks` (idempotent install + chmod +x). |
| `fs-watch.ts` | 75 | Chokidar wrapper exposing `AsyncIterable<WatchEvent>`. AbortSignal-aware: watcher is closed on abort, pending resolvers are drained with `done=true`. `ignoreInitial: false` so existing files at watch-start yield `add` events. |
| `jsonl.ts` | 253 | `encodeCwd` (non-alphanumeric → `-`). `discoverSessionJsonl`: retries with backoff, returns newest file by birthtime. `lastAssistantMessage`: walks back from end collecting consecutive assistant entries, retries if last entry lacks `stop_reason`. Defensive against multiple JSONL shapes. |

### Test Fixture

| File | LOC | Description |
|------|-----|-------------|
| `test/fixtures/fake-claude.sh` | 60 | POSIX bash. Reads prompts from stdin line-by-line. Writes plausible JSONL (user + partial assistant + final assistant with `end_turn`). Fires `FAKE_CLAUDE_HOOK` if set. Exits on `/exit` or EOF. |

### Integration Tests (`test/integration/`)

| File | LOC | Tests |
|------|-----|-------|
| `tmux.test.ts` | 141 | 9 |
| `fs-state.test.ts` | 171 | 14 |
| `hooks.test.ts` | 140 | 12 |
| `fs-watch.test.ts` | 135 | 5 |
| `jsonl.test.ts` | 288 | 17 |

**Total integration tests: 57. Total new LOC: 1577.**

## Test Results

```
185 pass (128 unit + 57 integration)
0 fail
bun run typecheck → clean
bun run lint → clean
tmux ls | grep rctrl- → no leaked sessions
```

## Design Decisions

- **`sendText` routing threshold**: multi-line (contains `\n`) OR length > 1000 chars → `load-buffer + paste-buffer`. Per findings Q7.
- **Unique buffer names**: `rctrl-buf-<6 random bytes hex>` per send. Prevents concurrent sends to different sessions from clobbering each other's buffer.
- **`discoverSessionJsonl` uses birthtime**: `stat.birthtimeMs >= sinceMs`. On macOS, birthtime is reliable. Returns newest when multiple files qualify (defensive against duplicate sessions).
- **`lastAssistantMessage` backward scan**: walks back from last line collecting consecutive assistant entries (the last turn), then checks the final entry for `stop_reason`. Retries with configurable backoff if incomplete. Per findings Q2.
- **`fs-watch.ts` queue + resolver pattern**: no EventEmitter. Push-to-queue when no awaiter; resolve immediately when awaiter is waiting. Clean abort via `signal.addEventListener('abort', close)`.
- **No `process.env` reads anywhere**: all adapters take `env?: Record<string, string | undefined>` explicitly. Consistent with S.U.P.E.R. (Uncoupled logic, Explicit data flow).

## Deviations from Spec

None. All specified functions, types, and behaviors are implemented exactly as documented. The `fake-claude.sh` uses `python3` for JSON-encoding of prompt text (POSIX `bash` has no native JSON encoder; `python3` is available on macOS and Linux).
