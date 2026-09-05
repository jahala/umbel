# Validation of bandung's dogfood report — umbel section

Source: `weed/bandung/docs/dogfood-report-2026-09-05.md`. Validated 2026-09-05 against
`ea995c5` and the installed binary (built 2026-08-20), on Claude Code 2.1.261 — the same
build the report tested.

Every finding was checked against running code, not read. Dialogs were observed by
launching the real binary on a private tmux socket, never by trusting the description.

## Verdicts

| ID | Verdict | Basis |
|----|---------|-------|
| U1 | **Confirmed — worse than reported** | Observed dialog + proved Enter kills the worker |
| U2 | **Confirmed — reproduced verbatim** | Observed dialog; Enter is safe here |
| U3 | **Confirmed** | `wait.ts` dead branch carries no snapshot |
| U4 | **Rejected — not a bug** | Proved correct behaviour empirically |
| U5 | **Confirmed** | No quota handling exists |
| U6 | **Confirmed** | Help string is Claude-only |

## U1 — trust dialog. Confirmed, and it is two defects

Observed on an untrusted clone, real binary, no umbel involved:

```
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
```

The cursor defaults to **No, exit**. Sending `Enter` was tested directly: the session
disappears. `claude.ts:285` sends a bare `Enter`, and its comment ("Default option is
'Yes, I trust this folder'") describes a release that no longer ships.

The matcher *does* hit — the option line contains "trust this folder" — so umbel actively
presses the destructive option rather than failing to notice the dialog.

**Second defect, not in the report.** Spawning through umbel left the worker *alive and
still sitting at the dialog*, not dead. `dismissStartupDialogs` marks a dialog `fired`
after one send and never retries, and nothing verifies the dialog cleared. If the
keystroke lands the worker dies; if it is swallowed before the TUI accepts input the
worker wedges to the wait deadline. Same root, timing decides which. Fixing the keys
alone leaves the wedge.

## U2 — external CLAUDE.md imports. Confirmed, reproduced

```
  Allow external CLAUDE.md file imports?
  ❯ No, disable external imports
    Yes, allow external imports
```

Enter selects "No", and the worker **proceeds to the main UI** — verified, session stayed
alive. Unlike U1 the default is safe, so a plain `['Enter']` matcher is correct here.

## U3 — nothing to inspect after death. Confirmed

`wait.ts` settles `reason: 'dead'` with no `paneSnapshot`, while the `timeout` and `idle`
branches both capture one. It cannot simply copy them: by the time the liveness probe
notices, the session is gone and there is nothing left to capture. A snapshot has to be
taken *while the worker is alive* and carried forward — a rolling capture during the wait.

The exit code the report also asks for is harder: tmux only retains it under
`remain-on-exit`, which changes teardown semantics. Worth treating separately.

## U4 — `sinceMtime: 0`. Rejected

`sinceMtime` is the mtime of `events/stop`, and that file does not exist until a worker's
first turn ends. Measured across two sends to one worker:

```
send #1 sinceMtime = 0                    <- before any Stop hook
send #2 sinceMtime = 1788634988148.783    <- after a completed turn
```

Working as designed. The reporter saw 0 every time because a conductor spawns a fresh
worker per node and sends one prompt — always the first send, always correctly 0, which
means "no stop recorded yet, any stop counts".

The report's proposed fix — return the transcript's mtime — would **break** the race
guard: the transcript is a different file with different timing. The legitimate residue is
that nothing documents 0 as a valid sentinel, which is why a careful reader flagged it.
Doc fix only.

## U5 / U6 — Confirmed

No `quota`/limit handling exists anywhere in `status.ts`. Help string at `cli.ts:38` still
reads "remote-control interactive Claude Code" above verbs driving four providers.

## Tasks

Ordered by cost of leaving it broken.

**T1. Trust dialog keys** *(critical)* — select the non-destructive option. Codex already
uses `['Down','Enter']` for this exact shape, so claude is the outlier. Prefer matching on
the highlighted line so a future reordering cannot silently re-arm it.

**T2. Dismissal must verify, not fire once** *(critical)* — re-send while the dialog is
still on the pane instead of marking it `fired` after one attempt. Without this a
swallowed keystroke wedges the worker regardless of T1. Ships with T1.

**T3. External-imports dialog matcher** *(high)* — `['Enter']`, text as observed above.

**T4. Real-binary startup-dialog smoke** *(high)* — the actual lesson. U1 is drift: a
matcher written against a release that changed. Gate on `UMBEL_SMOKE=1`, spawn into a
fresh untrusted clone, assert the worker reaches the main UI. Without this, T1 rots the
same way at the next Claude release.

**T5. Pane snapshot on death** *(medium)* — rolling capture during wait, returned with
`reason: 'dead'`. Also closes pleach's P1, which is blocked on umbel having anything to
hand over.

**T6. Surface the quota line** *(medium)* — a `quota` field on `status` from the pane, and
carry the blocking dialog's text into `wait`'s `message` so a conductor can name the cause
instead of reporting a generic "waiting for input".

**T7. Help text + providers doc** *(low)* — drop the Claude-only framing; record that the
free opencode lane is for probes, not gates.

**T8. Document `sinceMtime: 0`** *(low)* — state that 0 is a valid baseline.

T1–T4 are one coherent change to the same seam and should ship together. Features touched:
`worker-lifecycle` (dismissal loop, `startup-dialogs.ts`) and `provider-abstraction`
(per-provider declarations).
