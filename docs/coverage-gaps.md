# Coverage gaps — documented, not pursued

Current: **91.44% funcs / 96.54% lines** across all source.

Every remaining gap was reviewed. The ones left uncovered fall into three categories:

## 1. Inline `.catch(() => undefined)` lambdas (the "25% funcs / 100% lines" pattern)

Files affected:
- `src/operations/spawn.ts` — 25% funcs, 100% lines
- `src/faces/p.ts` — 50% funcs, 100% lines
- `src/faces/workflow.ts` — 83% funcs, 99% lines

Every line of these files is exercised by integration/e2e tests. The "uncovered functions" are the inline cleanup lambdas: `await kill(...).catch(() => undefined)` and similar. Each lambda counts as a function but only fires if the awaited promise rejects.

**Why not test:** to "cover" them we'd need to inject deps that throw during cleanup-after-failure paths. This is catching a catch — pure metric-gaming. The cleanup paths themselves *are* exercised; only the cleanup-fails-during-cleanup branch isn't.

**Acceptable.** Real bugs in cleanup logic surface as leaked tmux sessions, which the test harness checks for.

## 2. MCP stdio transport (`src/faces/mcp.ts` lines 174–240, ~78% lines)

The `runMcpServer()` function below `createMcpTools()`:
- Constructs `McpServer`
- Registers tools via `server.tool(...)`
- Opens `StdioServerTransport` and blocks on the abort signal

**Why not test:** every tool handler is covered by `test/integration/mcp-inproc.test.ts` calling `createMcpTools()` directly. The remaining lines are SDK wiring + the stdin-bound transport. Testing stdio means spawning a subprocess (which Bun's coverage doesn't trace anyway) or constructing a fake transport (theater — the SDK does the work). The e2e mcp-smoke test exercises the real stdio path via subprocess.

**Acceptable.** Smoke-tested via subprocess; in-process tests cover handler logic.

## 3. Defensive shape branches (`adapters/jsonl.ts` lines 42, 48, 50, 66-67, 205; `adapters/fs-watch.ts` lines 33, 106, 109-110; `core/wait.ts` line 23; `core/errors.ts` 87.5% funcs)

- `jsonl.ts`: branches for JSONL envelope shapes we may never observe in real Claude output (e.g. top-level `role: 'assistant'` with bare string content, or `assistant` `type` field without a message). Kept for defensive parsing; covering them requires constructing fixtures for shapes Claude may never produce.
- `fs-watch.ts`: the `unlink` and `change` branches of `fs.watchFile`'s listener (we exercise `add` but not deletion mid-watch); the `classify` catch for stat-on-nonexistent (tested indirectly via spawn-then-discover paths).
- `core/errors.ts`: 8/9 error classes are instantiated in unit tests. The 9th (`RctrlUsageError`) only carries `message` — its instantiation IS tested transitively via every CLI usage-error path, but the class declaration itself counts as a "function" not directly constructed in `errors.test.ts`.
- `core/wait.ts` line 23: an unreachable `return 'stop'` fallback in `inspectReason` when an `all`/`any` reduces to no triggered child. Documented as defensive in the source.

**Acceptable.** All are defensive guards. Real bugs in these branches would surface as observable behavior (wrong message extracted, missed event, wrong reason returned) and are caught by the integration tests of the calling code.

## 4. CLI verb handler edge cases (`src/faces/cli.ts` ~83% lines)

Lines 168-170, 216, 226, 253, 286-290, 369, 382-383, 398-399, 412-413, 438-449, 465, 511-512, 514-530, 532, 542-553, 560-561.

These are mostly:
- `attach` verb — replaces the current process with `tmux attach`. Can't be tested in-process without actually attaching.
- `logs --follow` — interactive tail; would block the test.
- A handful of error-formatting branches in the table printer.

**Acceptable.** `attach` and `logs --follow` are tested by the subprocess e2e tests (which Bun coverage doesn't trace). Error-formatting branches are exercised when their parent code path errors, but the specific format branches require deliberate orchestration.

## What's left if you really want 100%

Roughly:
- Refactor inline `.catch(() => undefined)` to named functions (no behavior change, +5% funcs metric).
- Construct stdio fake for MCP transport (~50 LOC, dubious value).
- Manually drive `attach` via a controlled tmux fixture (possible, ~30 LOC).
- Add JSONL fixtures for every shape variant.

Estimated effort: 2-3 hours. Estimated bug-finding value: very low. The remaining gaps are *defensive* code or *integration with external systems*, both of which are better tested by the integration layer (which they are).
