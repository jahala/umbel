import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  'Ground truth, read before coding: src/operations/spawn.ts dismissStartupDialogs (near line 36) polls d.tmux.capturePane(name, 40): nextStartupDialog (src/core/startup-dialogs.ts) picks the first matching not-exhausted dialog and its keys go through d.tmux.sendKeys (DIALOG_KEY_SETTLE_MS 300, MAX_DIALOG_ATTEMPTS 3); when no dialog matches and provider.readyMatch tests true the function returns; DIALOG_POLL_TIMEOUT_MS bounds it. It is called near line 331 only when opts.claudeBin is undefined — fakes bypass startup entirely. Providers: src/core/providers/codex.ts declares startupDialogs (update available → Down Enter; trust the contents of this directory → Enter; hooks need review → Down Enter), readyMatch /OpenAI Codex|Implement \\{|gpt-/i and submitDelayMs 750; claude readyMatch /Try |for shortcuts|│/; opencode readyMatch matches the Ask anything banner the fake prints. src/operations/send.ts (line ~52) calls d.tmux.sendText(name, text, {submitDelayMs}); src/adapters/tmux.ts sendText pastes through load-buffer + paste-buffer -p for multi-line or >1000-char text (send-keys -l otherwise), sleeps submitDelayMs, then send-keys Enter; sendKeys sends named keys. test/fixtures/codex-0.154-startup.txt holds two recordings of codex 0.154.0 starting under umbel (spawn returned 1.1 s after launch on the first banner frame with model: loading; the banner re-rendered twice; the usage-limit line arrived two seconds in; on one launch the trust dialog appeared after the banner and was never dismissed; on the other no dialog came and a trust entry was written). Fakes: test/fixtures/fake-codex.sh reads prompts from stdin line by line, writes a rollout JSONL under CODEX_HOME, fires the stop hook via FAKE_CODEX_HOOK, honours FAKE_CODEX_DELAY; fake-claude.sh and fake-gemini.sh likewise for their providers. Typed errors live in src/core/errors.ts and are mapped to exit codes in src/faces/cli.ts near line 222. test/integration/dismiss-dialogs.test.ts pins the dialog loop today; extend, never replace.',
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'pl.ready',
    claim:
      '`dismissStartupDialogs` declares codex ready only when the idle prompt line is on the pane, no startup dialog is pending and the pane has been unchanged for `readySettleMs`; replaying the recorded 0.154.0 frames (banner with `model: loading`, re-renders, the usage-limit line, the late trust dialog) it dismisses the dialog with Enter and returns only after the final frame settles',
    evidence: 'test/unit/codex-ready.test.ts',
    needs: [],
    how: `codex readyMatch becomes /› Ask Codex to do anything|Implement \\{/ (the idle prompt line, present on 0.154.0 and older builds; the banner line OpenAI Codex fires too early). AgentProvider gains readySettleMs?: number (codex 1500). In dismissStartupDialogs: once readyMatch holds and no dialog is pending, keep polling and return only when the pane has been unchanged for readySettleMs — dismissing any dialog that appears meanwhile (a dialog resets the settle); providers without readySettleMs return at once as today. Lift the claudeBin bypass at the call site so fakes go through the loop, and make every fake print its provider's ready line first thing (fake-claude a line containing for shortcuts, fake-codex › Ask Codex to do anything, fake-gemini whatever gemini.ts readyMatch matches; fake-opencode already prints Ask anything) so e2e spawns stay fast. The unit test drives dismissStartupDialogs with a scripted tmux dependency — capturePane returns frames from test/fixtures/codex-0.154-startup.txt in order, each held for a few polls, sendKeys records what was sent — and asserts: no return while the trust dialog frame shows, Enter sent for it, return only after the last frame has been stable for readySettleMs, and no keys sent on the frames without a dialog. Keep test/integration/dismiss-dialogs.test.ts green. ${GROUND}`,
  },
  {
    n: 2,
    id: 'pl.confirm',
    claim:
      'After the submitting Enter, `send` confirms the turn started: while the provider\'s `pendingInputMatch` still matches the pane after a short grace, Enter is sent again, at most three times; a fake codex that swallows the first Enter still runs its turn and `send` returns normally',
    evidence: 'test/integration/send-confirm-submit.test.ts',
    needs: ['pl.ready'],
    how: `AgentProvider gains pendingInputMatch?: RegExp (codex: /\\[Pasted Content \\d+ chars\\]/). In send.ts after sendText, when the provider declares it: poll capturePane every 300 ms for a 1500 ms grace; if the last lines still match, sendKeys Enter and poll again; at most three extra Enters. Providers without it are untouched. Fake-codex: FAKE_CODEX_SWALLOW_ENTERS=N — on a prompt line print › [Pasted Content <length> chars] and read N further stdin lines (each Enter arrives as an empty line) before running the turn, printing a line without the marker once the turn starts. Tests through spawn()+send()+waitFor(): swallow 1 → send resolves and wait reaches stop; swallow 0 → no extra Enter is sent (count the fake's stdin lines through a file it appends to, or assert the rollout has exactly one user turn). ${GROUND}`,
  },
  {
    n: 3,
    id: 'pl.not-submitted',
    claim:
      'When the pasted prompt is still pending after the bound, `send` throws `SendNotSubmittedError` naming the session and carrying the pane snapshot, mapped to exit 1 with the pending input line in the message; nothing further is typed into the worker',
    evidence: 'test/integration/send-not-submitted.test.ts',
    needs: ['pl.confirm'],
    how: `SendNotSubmittedError(session, paneSnapshot, enters) in src/core/errors.ts, thrown by send when the bound is exhausted; cli.ts maps it to exit 1 with a one-line message quoting the pending input line and the number of Enters sent. Fake: FAKE_CODEX_SWALLOW_ENTERS=99. Tests through send(): it rejects with the error carrying the pane; the worker received exactly the prompt plus the bounded Enters and no further text (the fake's stdin log or the rollout shows no turn); the session is still alive afterwards (send does not kill). ${GROUND}`,
  },
  {
    n: 4,
    id: 'pl.e2e',
    claim:
      'Through the CLI with the fake codex: `spawn` against the recorded 0.154.0 startup returns only after the trust dialog is dismissed and the prompt line has settled; `send` on a worker that swallows the first Enter exits 0 and `wait` reaches `stop`; on a worker that never takes the paste `send` exits 1 naming the pending input; docs/cli-reference.md\'s send section states the confirmation and its failure',
    evidence: 'test/e2e/send-confirm.test.ts',
    needs: ['pl.not-submitted'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/cli.test.ts. Fake-codex: FAKE_CODEX_STARTUP=0154 renders the recorded sequence with its timings (banner with model: loading; a second later the full banner, the Tip and the usage-limit line; a second after that the trust dialog, which waits for an Enter on stdin; then the idle prompt line) before reading prompts. CLI runs: spawn with that fake returns after the dialog was answered (the fake records the Enter) and not before the settle; send on swallow 1 → exit 0 and wait → stop; send on swallow 99 → exit 1 with the pending input line on stderr. Docs: docs/cli-reference.md send section — the confirmation, the bound, the failure and its exit code; spawn section — readiness is the idle prompt line plus a settle for providers that declare one. Pin the docs in the same file. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/prompt-lands.tend2.html',
  payload: '9e6c0c5ae46b',
  title: 'The prompt lands, or the send fails',
  goal: 'A worker is ready when its input line is idle and nothing is still arriving (codex readiness is the idle prompt line plus a settle window, with late dialogs still dismissed), and a prompt is sent when the worker has taken it: send re-reads the pane, re-sends Enter a bounded number of times while the paste is still pending, and fails with a typed error carrying the pane when it never lands.',
  issue: 'jahala/umbel#77',
  sink: 'pl.e2e',
  checks,
};

export default spec;
