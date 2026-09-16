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
- **CI refused the landing on Linux tmux, twice over.** On the ubuntu runner (tmux 3.4) every
  death settled with "tmux recorded no status": the liveness probe landed between the pane's EOF
  and tmux reaping the child, and the status was there a moment later. The same tmux names a
  signal by number (15) where macOS tmux 3.6b names it `term`. With no Linux at hand, a probe
  branch with a draft PR (jahala/umbel#90, closed unmerged) printed the runner's raw formats; the
  fix — a bounded settle in the dead path and the platform's signal table in the describer —
  landed with two failing tests first. The merge chain did what it should: no merge on red.
- **Still red on the runner with the settle.** The six death tests fail the same way on ubuntu's tmux
  3.4 after the one-second re-read, while the bare-pane probe records the status there. The
  difference lies in umbel's launch of the fake or in how long the runner takes; not diagnosable
  from a Mac without another runner cycle. Filed as 91 (https://github.com/jahala/umbel/issues/91); the PR stays open and
  unmerged, and the tier holds here.
- **The umbrella's ruling (2026-09-16):** record the worker's exit status and signal through umbel's
  own wrapper into the events directory at the moment the process ends, platform-independent;
  tmux's pane status becomes a fallback, never the source; no tmux version special-cased. Shaped
  as c6 and conducted alone from a one-node sub-plan (`plan-record.json`) whose worktree starts
  from the branch tip, so the five landed nodes are neither re-dispatched nor touched; its audit
  verifies the whole page. The page's payload pin moved with the new check (8760a48a21e6); the
  landed nodes' receipts keep the old pin, as their audits happened under the old page.
- **c6 built alone in one attempt (40m34s), red first.** The red test wraps the real tmux adapter so a
  dead pane reports neither status nor signal — ubuntu's semantics on any machine — and asserts the
  death is still read as exit 3 or SIGTERM. The wrapper (`<state>/hooks/exec.sh`, installed beside
  the hooks) runs the worker, forwards the signals it can, records `events/exit` at the end and
  exits with the same status; wait, kill and status read the record first through one helper and
  fall back to tmux. Landed at deb207c; `bun run check` 893 green; the whole page (six checks)
  stamped by the pinned tend2 after landing.
