# Dogfood — prompt-lands (jahala/umbel#77)

What the pleach agent hit in tend2, pleach, umbel and weeder while shaping and conducting this
loop, the third conducted loop on umbel. Findings that apply to every umbel loop are recorded once
in `opencode-config-survives.md`; this file carries what this loop added.

## Shaping (2026-09-11)

- **The issue's race was recorded before shaping.** Two launches of codex 0.154.0 through
  `umbel spawn --provider codex --unattended` into fresh temp directories, captured with `umbel
  capture` at 1, 3, 6 and 10 seconds (`test/fixtures/codex-0.154-startup.txt`): `spawn` returned
  1.1 s after launch on the first banner frame (`model: loading`), the banner re-rendered twice more
  over three seconds, the usage-limit line arrived two seconds in, and on one launch the
  workspace-trust dialog appeared after the banner — after `readyMatch` had fired and the dialog
  loop had returned — and stayed on the pane; that directory got no trust entry in umbel's codex
  home, the other launch did. A prompt pasted into that window lands on a screen still being built.
- **`readyMatch` matched the banner, not readiness.** `/OpenAI Codex|Implement \{|gpt-/i` fires on
  the first frame; the idle prompt line (`› Ask Codex to do anything`) is present on every frame
  too, so readiness has to be idle-and-settled, not a line match.
- **The fakes bypassed startup entirely.** `dismissStartupDialogs` ran only when no fake binary was
  injected, so the e2e path never exercised the dialog loop. The loop lifts the bypass and has each
  fake print its provider's ready line.

## Conducting (2026-09-15)

- **pl.ready closed with no handback, and the worker had spoken.** Its transcript ends with a text
  turn and three dated Tried lines; umbel's `parseTranscript` over the file returns 1375 bytes. pleach's
  umbel adapter turns a non-zero `umbel read` into an empty final message and keeps nothing, so the
  read's own error is lost and the session directory is gone by then. Recorded on jahala/pleach#109
  (which had first been filed for a resumed node); umbel's side is unobservable until #73 keeps
  dead sessions' state. The Tried line for c1 is transcribed from the transcript itself, not the handback.
- **Three of four handbacks were not the worker's last words.** pl.ready and pl.confirm reached pleach as
  empty final messages; pl.e2e's kept handback ends with "Only (4) is outstanding" while its transcript
  goes on to a tool call and a final text with the Tried line. One cause fits all: Claude Code fires
  the Stop hook before the final assistant entry is on disk, so `umbel read` at Stop parses a transcript
  that lags the hook (jahala/umbel#86). The Tried lines for c1, c2 and c4 are transcribed from the
  transcripts; the wedged-worker page's c2 line was corrected the same way.

### The run, in numbers (2026-09-15)

Run: `bun /tmp/pleach-pinned/src/main.ts run docs/dogfood/prompt-lands/plan.json --repo-root . --max-concurrency 1`,
once. Workers claude-opus-5 through the installed umbel, smoke `weeder check --strict`, audit = the
pinned tend2 (a33d5fb) verifying the node's check as a self-integral audit run by opencode +
deepseek/deepseek-v4-pro. Result: 4 of 4 nodes verified in 4 attempts; landed by `pleach land` (land gate
green) onto feat/prompt-lands at 6421796; `bun run check` green (862 tests, from 845); every check
stamped by the pinned tend2. Both sinks so far in this tier found an honest red, so no proof-node
reshaping was needed.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| pl.ready | c1 | 1 | 20m54s | — |
| pl.confirm | c2 | 1 | 19m58s | — |
| pl.not-submitted | c3 | 1 | 18m30s | — |
| pl.e2e | c4 | 1 | 26m37s | — |
- **CI refused the landing once, on a timing premise in an old test.** The workflow abort e2e aborted
  100 ms in and assumed the fake had not answered; on the ubuntu runner the step had completed
  first (umbel#88). Enforced with the fake's delay instead of the timer; the merge chain did what
  it should — `&&` after the check watch, no merge on red.
