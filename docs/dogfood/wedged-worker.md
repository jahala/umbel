# Dogfood — wedged-worker (jahala/umbel#67)

What the pleach agent hit in tend2, pleach, umbel and weeder while shaping and conducting this
loop, the second conducted loop on umbel. The shaping-pass findings that apply to every umbel loop
are recorded once in `opencode-config-survives.md`; this file carries what this loop added.

## Shaping (2026-09-11)

- **The counter-case is pleach's own false idle.** On 2026-09-12 a claude worker under pleach
  waited on a subagent; the pane did not change for ten minutes while the subagent's transcript
  kept arriving under `<session-id>/subagents/`, `wait --idle-timeout 10m` answered `idle` with no
  message, and the conductor settled the node blocked. Verified on disk: Claude Code 2.1.x writes
  subagent transcripts to `<transcript dir>/<session-id>/subagents/agent-*.jsonl`. That is the
  first check.
- **Pane change is a noisy activity signal.** Recording codex 0.154.0 through `umbel spawn`
  showed the banner re-rendering three times in the first three seconds with nothing happening;
  a pane-only idle net reads every re-render as activity. The transcript tree and the events
  directory are the honest sources; the pane stays as the third.
- **The new reason changes pleach's contract.** pleach's classifier treats unknown wait reasons
  as terminal today; `provider-error` needs its own classification there (a failed attempt with the
  message as evidence). Scoped out of this loop as pleach's own issue, filed at landing.

## Conducting (2026-09-11, aborted on the umbrella's hold)

- The first node (ww.sources) was dispatched at 16:34:58Z; cape-town's hold arrived a minute later
  and the run was drained with `pleach stop --now`. The abort settled cleanly on the fixed conductor
  (411a1eb): aborted verdict, receipt, `quarantine/ww.sources` kept, run-aborted, run-stopped,
  run-end — the abort path that lost its tree under pleach#102 keeps it now. The loop resumes from
  that quarantine on the same command when the slot reopens.
- A SIGINT aimed at the zsh wrapper of a backgrounded run does not reach the conductor; `pleach stop
  --now` finds the run's pid from the lock and signals it directly.

## Conducting (2026-09-15, resumed from the quarantine)

- ww.sources resumed from its quarantine on the re-pinned conductor (411a1eb) and verifier (a33d5fb)
  and closed in one attempt (19m). ww.message settled `blocked` in one attempt: its evidence was
  green (26 pass) but `bun run check` was red with 15 failures unrelated to the change — the machine's
  macOS 27.0 upgrade reset the Xcode license and `/usr/bin/python3`, which the fake binaries use to
  JSON-escape their transcript lines, refuses to run. The worker proved the same failures on a
  detached HEAD without its change, declined to rewrite three shared fixtures inside a feature node
  and declined to change the machine, and wrote BLOCKED.md. Filed as 81 on umbel
  (https://github.com/jahala/umbel/issues/81); the loop holds until the fixtures or the machine are fixed.
- The worker's scratch worktree (`.loop-scratch/head`, detached) stayed registered after its node
  was disposed because the guard hook blocks the worktree-remove verb; a prune clears the stale entry.
- The owner accepted the Xcode license; `bun run check` went green (821 pass) with no code change
  and the loop resumed at ww.message from its quarantine. umbel#81 stays open for the fixtures.

### The run, in numbers (2026-09-15)

Run: the same command three times: run 1 (2026-09-11) aborted on the umbrella's hold two minutes
in; run 2 closed ww.sources and settled ww.message blocked on the machine; run 3 closed the rest.
Workers claude-opus-5 through the installed umbel, smoke `weeder check --strict`, audit = the pinned
tend2 (a33d5fb) verifying the node's check as a self-integral audit run by opencode +
deepseek/deepseek-v4-pro. Result: 4 of 4 nodes verified in 5 attempts on the working machine
(6 counting the aborted one); landed by `pleach land` (land gate green) onto feat/wedged-worker at
b3f2b9c; `bun run check` green (845 tests, from 821); every check stamped by the pinned tend2.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| ww.sources | c1 | 1 (+1 aborted) | 18m48s | run 1 aborted at 2m10s on the umbrella's hold; resumed from quarantine |
| ww.message | c2 | 1 + 1 | 13m55s + 10m31s | attempt 1 blocked on the machine (umbel#81); resumed from quarantine — pleach kept no handback for the resumed close (jahala/pleach#109) |
| ww.provider-error | c3 | 1 | 14m54s | — |
| ww.e2e | c4 | 1 | 22m10s | the sink found an honest red (exit 122 and the docs were still missing) |
