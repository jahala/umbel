# Dogfood — opencode-config-survives (jahala/umbel#53)

What the pleach agent hit in tend2, pleach, umbel and weeder while shaping and conducting this
loop — the first conducted loop on umbel, driven by the pinned pleach (9e1c3eb) with claude-opus-5
workers through the installed umbel, `weeder check --strict` as smoke, the pinned tend2 (cf8ba13)
verifier on each check as a self-integral audit run by opencode + deepseek/deepseek-v4-pro.

## Shaping (2026-09-11)

- **umbel #72 needed no loop.** Master carried the fix (ab0469f, #62) three days before the issue
  was filed; the real-binary smoke passes on Claude Code 2.1.268. Closed with the evidence. The umbel
  clone pleach drives is itself untrusted, so every conducted worker re-proves the dismissal live —
  the first worker of this loop spawned into a fresh worktree and was alive and building.
- **tend2: a fully skipped suite is stamped as proven** (jahala/tend#207). `bun test` exits 0 on a
  file whose only test is `describe.skip`ped, and `verify` stamps the check; the pinned build prints
  `tests: unknown` and stamps anyway. umbel's real-binary smokes are gated by `UMBEL_SMOKE=1`, so a
  smoke-backed check audited inside a worker would always pass. No check in this loop cites a smoke.
- **tend2: `emit-plan`'s unwired-modules preflight reads a backticked `//` as a source module**
  (`6 checks cite 2 src modules (//, src/core/errors.ts)`). Harmless, wrong.
- **tend2 on PATH was not master.** `/opt/homebrew/bin/tend2` is a global link to an August 21 build
  from another worktree (the umbrella's finding); every verify and audit now runs the pinned build by
  path (`node /tmp/tend2-pinned/dist/cli.js`), as the conductor is pinned. Both builds compute the
  same payload pin for this page (50a8f8de3550).
- **tend2 `emit-plan` puts the verifier in `accept.smoke`, not `accept.audit`**, one node per loop,
  no phases — the known gaps (jahala/tend#158); the hand-split generator is `docs/dogfood/make-plan.ts`.
- **umbel: docs/cli-reference.md documents `UMBEL_OPENCODE_BIN`; nothing in src reads it.** Only
  `UMBEL_CLAUDE_BIN` exists and overrides the bin for every provider (jahala/umbel#79).
- **umbel: the claude startup-dialogs smoke leaves a dead session directory behind on every run**
  (`smk-trust-*` listed dead by `umbel ls`); its cleanup guard kills tmux but not the state.
- **umbel: codex 0.154.0's startup is a race umbel loses** — recorded twice through `umbel spawn`
  (`.loop-scratch/codex-0.154-*.txt`): `spawn` returns 1.1 s after launch on the first banner frame
  (`model: loading`), the screen keeps building for three seconds, and on one launch the trust dialog
  arrived after `readyMatch` had fired and stayed on the pane (no trust entry written for that
  directory; the other launch got one). The shape of jahala/umbel#77; drafted as the `prompt-lands` loop.

## Conducting (2026-09-11)

- **pleach: the aborted node's quarantine failed with ENOTDIR under `--repo-root .`** (jahala/pleach#102).
  The first run was interrupted three minutes in to switch the audits to the pinned tend2; the abort
  settled cleanly (aborted verdict, receipt, run-end) but `quarantine-failed` reported `git status`
  refused `.git/pleach/worktrees/wt-30ihSu/wt: Not a directory` — a relative worktree path resolved
  against the worktree's own cwd, whose `.git` is a file. The tree was disposed; nothing was kept.
  The second run failed the same way with no abort, seven minutes in, after the worker stopped:
  `failed after 0 attempt(s)`, no receipt, no quarantine. Root cause: in a plain clone
  `git rev-parse --git-dir` is the relative `.git`; pleach builds the worktree base from it and the
  isolate seam runs `git -C <path>` with `cwd: <path>`, so the relative path is resolved twice, the
  second time from inside the worktree where `.git` is a file. Every plain clone is affected; the
  eight cayenne loops never saw it because a Conductor workspace is a git worktree with an absolute
  git-dir. Raised to P1; fixed by hand during the hold under the direct-work rule — jahala/pleach#103, merge commit 411a1eb (ledger D22); the pinned conductor is re-pinned to it before the loop resumes.
- **Session limit.** cape-town called a hold after the second failure; one agent runs at a time from
  here. umbel 53 stood at 0 of 6 nodes, nothing quarantined, branch shaped and pushed.
- **The fix, proven on the observed shape before the re-pin.** With jahala/pleach#103's branch, a fresh
  plain repo (`git rev-parse --git-dir` → `.git`) and `pleach run plan.json --repo-root .` closed a
  command node (`1 closed`); the sibling (`--repo-root <basename>` from the parent directory) is
  pinned by an e2e test and a second check (c12) on pleach's isolate-seam loop.
- **Resumed on the re-pinned conductor (411a1eb) and the re-pinned tend2 (a33d5fb).** tend2's seam
  loop landed meanwhile: `emit-plan` now writes one phased node per code check (red/impl/green,
  chained in page order) plus a closing command node, and its payload pin for this page is unchanged
  (50a8f8de3550). Its nodes carry no `setup`, no weeder smoke, no cross-provider audit and no
  `closes`; the verifier sits in `accept.smoke`. The hand plan keeps those gates, so this loop ran on
  the hand plan; the emitted plan validates against the pinned pleach and is kept beside it for the
  comparison (`.loop-scratch/emit-a33d5fb.json`, not collected).
