# Dogfood — dead-worker-evidence (jahala/umbel#73)

What the pleach agent hit in tend2, pleach, umbel and weeder while shaping and conducting this
loop, the last of umbel's tier one. Findings that apply to every umbel loop are recorded once in
`opencode-config-survives.md`; this file carries what this loop added.

## Shaping (2026-09-11 to 16)

- **The loop was re-aligned to the runner contract before placement.** `contracts/runner.md` on
  jahala/plotplot (2026-09-15) lists the nine wait reasons with exit codes and verdict classes and
  says a result carries a message naming what was observed. `dead` keeps its reason and exit code
  125; this loop adds `exitCode` and a message naming the exit status, no new reason.
- **Why tombstones, in this week's own evidence.** Three handbacks were lost on 2026-09-15 because
  umbel's `read` at Stop lagged the transcript (umbel#86); the sessions' directories were gone by
  the time anyone looked, so the read's error was unobservable. A kept directory would have shown it.
- **The real-binary smoke leaves dead session directories today** (`smk-trust-*` listed dead by
  `umbel ls` since 2026-09-05); with tombstones by design, the smoke helper's cleanup moves to
  `kill --purge` in the sink node, and `prune` sweeps the rest.

## Conducting (2026-09-16)

Run: `bun /tmp/pleach-pinned/src/main.ts run docs/dogfood/dead-worker-evidence/plan.json --repo-root . --max-concurrency 1`,
once. Workers claude-opus-5 through the installed umbel, smoke `weeder check --strict`, audit = the
pinned tend2 (a33d5fb) verifying the node's check as a self-integral audit run by opencode +
deepseek/deepseek-v4-pro. Result: 5 of 5 nodes verified in 5 attempts; landed by `pleach land` (land gate
green) onto feat/dead-worker-evidence at 03ea0b8; `bun run check` green (883 tests, from 862); every
check stamped by the pinned tend2. The sink found an honest red; no proof-node reshaping.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| dw.pane | c1 | 1 | 43m08s | — |
| dw.wait | c2 | 1 | 37m37s | — |
| dw.kill | c3 | 1 | 44m43s | — |
| dw.prune | c4 | 1 | 23m56s | — |
| dw.e2e | c5 | 1 | 25m52s | — |

- **Every handback of this loop reached pleach empty.** All five Tried lines are transcribed from the
  workers' transcripts (umbel#86: `read` at Stop lags the transcript). The installed umbel is still
  the 2026-09-05 build; the loops landed this week (tombstones, the settled readiness, the
  transcript-aware idle net) reach the conductor only when the binary is rebuilt from master — the
  owner's action, not the loop's.
- **The nodes of this loop ran long** (24–45 minutes each, against 13–20 for the earlier loops): the
  tmux liveness change touched spawn, wait, status and kill at once, and each worker re-ran the whole
  suite several times. One attempt each; nothing retried.
