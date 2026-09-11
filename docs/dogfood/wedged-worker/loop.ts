import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  'Ground truth, read before coding: src/operations/wait.ts waitFor() has wake sources (the stop-event file watched through src/adapters/fs-watch.ts, timers), a 500 ms liveness probe through d.tmux.hasSession that settles dead with lastAlivePane, a notification baseline (events/notification mtime → input with inputReason from src/core/notification.ts classifyNotification), and an opt-in idle net: opts.idleTimeoutMs, polled every max(250, min(2000, idle/4)) ms through d.tmux.capturePane(name, 50), settling {reason: idle, paneSnapshot} when the pane text is unchanged for idleTimeoutMs. WaitResult.reason is the union at the top of the file; src/faces/cli.ts maps reasons to exit codes near line 512 (timeout 124, dead 125, input 126, idle 123, aborted 130) and prints {reason, message?} as --json; the exit codes are also listed in the help text and in docs/cli-reference.md. The transcript path comes from src/operations/resolve-jsonl.ts resolveJsonlPath (meta.jsonlPath → events/transcript-path → d.jsonl.discoverSessionJsonl by cwd + sinceMs; throws SessionDeadError when unresolvable). For claude the subagent transcripts live at <dirname(transcript)>/<basename without .jsonl>/subagents/agent-*.jsonl (verified on disk, Claude Code 2.1.x). codex writes its rollout JSONL under $CODEX_HOME/sessions/YYYY/MM/DD/; opencode has no transcript file (exportTranscript command) and gemini follows its own path. The session events dir (d.fs.eventsDir) holds stop, log (a timestamp appended per hook event), notification, transcript-path, quota, session-id. Providers are declared in src/core/providers/{claude,codex,gemini,opencode}.ts against AgentProvider in src/core/providers/types.ts. Fakes: test/fixtures/fake-claude.sh reads prompts from stdin, writes a JSONL transcript at ~/.claude/projects/<encoded cwd>/<session>.jsonl (or FAKE_CLAUDE_JSONL_DIR) and fires the stop hook via FAKE_CLAUDE_HOOK; fake-codex.sh writes a rollout JSONL under CODEX_HOME and honours FAKE_CODEX_DELAY; fake-opencode.sh has no transcript file. Integration tests spawn through spawn() with claudeBin set to the fake and UMBEL_STATE under a tmp dir; read test/integration/wait.test.ts and wait-diagnostics.test.ts (the idle-net tests) and extend them, never replace them.',
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'ww.sources',
    claim:
      '`wait --idle-timeout` measures stillness across the pane, the session\'s events directory and the transcript tree (the resolved transcript and, for claude, its `<session-id>/subagents/` directory): a worker whose pane is silent while a subagent transcript keeps growing settles `stop` when its turn ends, not `idle`; a worker whose every source is still for the threshold settles `idle`',
    evidence: 'test/integration/wait-idle-sources.test.ts',
    needs: [],
    how: `Give the idle poll an activity fingerprint instead of the pane text alone: the pane text, the newest mtime under the events dir, the mtime of the transcript file and the newest mtime under its subagents directory when the provider is claude. Resolve the transcript path cheaply per poll (meta.jsonlPath or events/transcript-path); fall back to discovery only every few polls (it scans a directory) and treat an unresolvable transcript as contributing nothing. Reset lastChangeAt whenever any part of the fingerprint moves; settle idle only when nothing moved for idleTimeoutMs. Fake: FAKE_CLAUDE_SUBAGENT_MS — during the turn print nothing to the pane, append one JSON line every 300 ms to <transcript dir>/<session>/subagents/agent-fake.jsonl for that long, then write the turn and fire the hook; FAKE_CLAUDE_HANG_MS — print nothing, write nothing for that long, then finish. Tests through waitFor(): a 4000 ms silent subagent with idleTimeoutMs 1500 settles stop; a 4000 ms hang with 1500 settles idle between 1500 and ~2500 ms; a turn that prints to the pane every 500 ms for 4 s with 1500 settles stop (today's behaviour, kept). ${GROUND}`,
  },
  {
    n: 2,
    id: 'ww.message',
    claim:
      'An `idle` result carries a `message` naming each source watched and how long it has been still; a source that could not be resolved is named as unresolved rather than silently omitted',
    evidence: 'test/integration/wait-idle-message.test.ts',
    needs: ['ww.sources'],
    how: `WaitResult.message on idle, built by a pure function in src/core (given the per-source last-change times and the now): one line naming every source with its stillness, e.g. idle 1.5s: pane still 1.6s · events still 4.0s · transcript still 1.7s · subagents none — the exact wording is yours, but each source is named, and a transcript that could not be resolved reads transcript unresolved. The CLI's --json already carries message for input; make idle carry it too. Tests: the hang fake (all sources named with numbers), and a fake-opencode session (no transcript file) whose message says unresolved. Unit-test the pure formatter in the same file or beside it. ${GROUND}`,
  },
  {
    n: 3,
    id: 'ww.provider-error',
    claim:
      'A pane whose last lines match the provider\'s `errorMatch` and then stay still for the grace settles `provider-error` with the matched line as `message` and the pane as `paneSnapshot`, well before the idle threshold; an error line followed by further output does not settle; codex and claude declare their patterns',
    evidence: 'test/integration/wait-provider-error.test.ts',
    needs: ['ww.message'],
    how: `AgentProvider gains optional errorMatch: readonly RegExp[] — codex: /unexpected status \\d{3}/i and /does not exist or you do not have access/i (the lines observed on 2026-09-09 and 2026-09-10); claude: /API Error/ — with a comment naming where each was seen. In the idle poll, when the last fifteen non-empty pane lines match any pattern and the fingerprint has been still for a grace of max(two polls, 3 s), never more than idleTimeoutMs, settle {reason: provider-error, message: the matched line trimmed, paneSnapshot}. Add provider-error to the reason union (the docs and exit code are the next check). Fake-codex: FAKE_CODEX_ERROR=<line> prints the line on receiving a prompt and then sleeps forever (no turn, no hook); FAKE_CODEX_ERROR_THEN_CONTINUE=1 prints it, sleeps 1 s, then runs the turn. Tests through waitFor() with idleTimeoutMs 60000: the 404 line settles provider-error within about 5 s with the line as message; then-continue settles stop; a claude fake printing API Error: 529 overloaded and continuing settles stop. ${GROUND}`,
  },
  {
    n: 4,
    id: 'ww.e2e',
    claim:
      'Through the CLI: `umbel wait --json --idle-timeout` exits 122 with `{"reason":"provider-error","message":…}` on the fake codex\'s 404 pane, 123 with the sources message on a hung fake, and 0 with `stop` on a silent-subagent fake; docs/cli-reference.md\'s exit-code table, `umbel --help` and `wait`\'s reference list 122 and the idle message',
    evidence: 'test/e2e/wait-wedged.test.ts',
    needs: ['ww.provider-error'],
    timeoutMs: 2_700_000,
    how: `Model on the wait cases in test/e2e/cli.test.ts (how the CLI entry is invoked, how fakes and UMBEL_STATE are passed). Map provider-error to exit 122 in src/faces/cli.ts and add it to the help text's exit-code list; in docs/cli-reference.md add the 122 row to the exit-code table, describe provider-error and the idle message in the wait section, and say in the --idle-timeout row that stillness is measured across the pane, the events directory and the transcript tree. Three CLI runs on fakes: the 404 line → exit 122 and JSON {reason: provider-error, message}; a hang → 123 with a message naming the sources; a silent subagent → 0 with stop. Pin the docs in the same file (the table lists 122; the wait section names the three sources). This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/wedged-worker.tend2.html',
  payload: '692c679bf7b6',
  title: 'A wedged worker is a failure, and a busy one is not',
  goal: 'umbel wait tells a worker that has stopped from one that is quietly working: idleness is measured across the pane, the events directory and the transcript tree (a claude worker\'s subagent transcripts included), an idle result says what stayed still and for how long, and a provider error on the pane followed by stillness is reported at once as provider-error with the error line, exit 122.',
  issue: 'jahala/umbel#67',
  sink: 'ww.e2e',
  checks,
};

export default spec;
