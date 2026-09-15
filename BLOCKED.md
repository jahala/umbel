# BLOCKED: c2 GREEN, `bun run check` is red for an environment reason

## What stops green

`bun run check` ends with 816 pass and 15 fail. Typecheck passes, and biome reports 7 warnings and no errors. All 15 failures have the same cause, and none is in c2's work.

The fake binaries build their JSONL transcript lines with `python3 -c 'import json,sys; ...'` (`test/fixtures/fake-claude.sh:56,95`, `fake-codex.sh:55,60,65`, `fake-gemini.sh:53,59`). On this machine the only `python3` is `/usr/bin/python3`, the Xcode shim. It exits 69 with "You have not agreed to the Xcode license agreements". So the fakes never write their `Response to: …` line, and every test that reads the final assistant message gets `Thinking...` or an empty string.

These are the failing tests:
- `actions --json`
- `codex-provider` end-to-end turn
- `gemini provider` parseTranscript
- `cli — read`
- `cli — -p mode`
- `workflow` ×3
- `p-mode` ×6
- `cli -p "hi"`

## Evidence it is not the c2 change

- A detached checkout of HEAD without the c2 change fails the same tests. `test/e2e/p-mode.test.ts` and `test/integration/codex-provider.test.ts` gave 7 fail there too. That checkout is `.loop-scratch/head`.
- None of the failing tests passes `idleTimeoutMs`, which is the only path the change touches.
- The c2 evidence passes: `test/integration/wait-idle-message.test.ts`, `test/unit/idle-message.test.ts`, `test/integration/wait-idle-sources.test.ts`, `test/integration/wait.test.ts` and `test/unit/wait-diagnostics.test.ts` give 26 pass, 0 fail.

## What I did not do, and why

- **Rewrite the fakes to escape JSON with `jq`:** that changes three shared fixtures outside this node's work, and weeder would rightly flag files outside the work. It deserves its own node, since the fixtures depending on the Xcode python shim is a real fragility.
- **Install another python or change PATH:** that edits the machine environment, which is not mine to change.

## What a fix needs

One of these:
1. Someone with admin rights runs `sudo xcodebuild -license accept` on this machine, then reruns `bun run check`. This needs no code change.
2. A separate node replaces the `python3` JSON escaping in `test/fixtures/fake-{claude,codex,gemini}.sh` with `jq -Rs .`. `jq` is already required by `stop.sh`.

## Also left behind

A git hook blocked `git worktree remove`, so the scratch worktree `.loop-scratch/head` (detached, unchanged) is still registered and needs removing.
