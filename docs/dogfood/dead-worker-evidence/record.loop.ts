import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  'Ground truth, read before coding — this tree already carries the five landed nodes of this loop: src/adapters/tmux.ts newSession sets remain-on-exit and launches opts.cmd directly (new-session -d -s <name> -c <cwd> -e K=V … -- <bin> <args>), and paneState(name) reads list-panes -F "#{pane_dead} #{pane_dead_status} #{pane_dead_signal}"; src/operations/wait.ts\'s liveness probe (near the DEAD_RECORD_SETTLE_MS loop) settles dead with a DeathCause from paneState, describes it with src/core/death.ts describeDeath, and writes events/dead through d.fs.writeDead; src/operations/kill.ts writes the tombstone (events/dead with by: kill) from paneState + a capture before tearing the session down; src/operations/status.ts enrich() reads paneState and d.fs.readDead. Hook scripts are installed by src/adapters/hooks.ts under <state>/hooks/ (stop.sh, notify.sh) and passed to the provider by absolute path from src/operations/spawn.ts; the worker gets UMBEL_STATE and UMBEL_SESSION_ID in its environment. The session directory is <UMBEL_STATE>/sessions/<name>/ with meta.json and events/; src/adapters/fs-state.ts owns it (eventsDir, writeDead, readDead — add the exit record beside them). test/fixtures/fake-claude.sh dies with FAKE_CLAUDE_DIE_MS + FAKE_CLAUDE_EXIT_CODE (exit) or FAKE_CLAUDE_DIE_SIGNAL (kill -s … $$). On the ubuntu runner (tmux 3.4) paneState reported dead with neither status nor signal for these deaths (jahala/umbel#91, CI runs 35047058719 and 35048430344) while macOS tmux 3.6b reported them; the record must not depend on either. Unit tests may inject deps (see test/unit/wait-dead-settle.test.ts for a scripted tmux dep); integration tests spawn the fake through spawn() with UMBEL_STATE under a tmp dir.',
].join(' ');

const checks: Check[] = [
  {
    n: 6,
    id: 'dw.record',
    claim:
      "The worker's exit status or signal is recorded by umbel's own wrapper into `events/exit` at the moment the process ends, on any platform; the dead path, `kill`'s tombstone and `status` read that record first and tmux's pane status only as a fallback; a fake that exits 3 and one killed by SIGTERM are read as such even when tmux records nothing",
    evidence: 'test/integration/exit-record.test.ts',
    needs: [],
    timeoutMs: 2_700_000,
    how: `RED first: spawn the fake through spawn() with a tmux dep whose paneState is the real one except that a dead pane reports neither exitCode nor signal (wrap the real adapter: call through, then strip the two fields when dead) — the ubuntu semantics, reproduced on any machine; send a prompt that dies with FAKE_CLAUDE_EXIT_CODE=3 → waitFor must settle dead with exitCode 3 and message process exited 3, events/exit must hold {exitCode: 3}, events/dead must carry it, status() must show dead (exit 3); the same with FAKE_CLAUDE_DIE_SIGNAL=TERM → exitCode undefined, message killed by SIGTERM, events/exit {signal: SIGTERM}; and kill() of a live fake must write the tombstone as today. Then implement: a wrapper script <state>/hooks/exec.sh installed by src/adapters/hooks.ts like stop.sh — bash, runs "$@" in the foreground with signals forwarded to the child (trap a list of signals: forward with kill and remember the name), records at the end: an exit status → printf '{"exitCode":%d}' into $UMBEL_STATE/sessions/$UMBEL_SESSION_ID/events/exit; a child killed by a signal (status ≥ 128, name from kill -l) or the wrapper's own trapped signal → {"signal":"SIGTERM"}; write to a temp name and mv into place (atomic), then exit with the same status so tmux's pane_dead_status still agrees. spawn.ts prefixes the wrapper to opts.cmd (the worker's argv is untouched; the wrapper adds nothing to the pane). fs-state.ts gains readExit(name, env) → {exitCode} | {signal} | null. wait.ts's dead path: on a dead pane, read events/exit first (it is written before the process ends, so it is there by the time the pane is dead; keep a short bounded re-read in case the file's mv lands a moment later), and only when absent fall back to paneState's status/signal with the existing settle. kill.ts and status.ts read the record the same way (a shared helper in src/operations/death-record.ts or beside readDead). Keep the five landed checks green (their tests read exitCode from the result, which now comes from the record). Docs: docs/cli-reference.md's dead row names events/exit as the source and tmux as the fallback. This node is the sink: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/dead-worker-evidence.tend2.html',
  payload: '8760a48a21e6',
  title: 'A dead worker leaves its evidence',
  goal: "A worker that dies leaves what a post-mortem needs. The exit status or signal is umbel's own record, written by a wrapper into the session's events directory at the moment the process ends on any platform; tmux's pane status is a fallback, never the source. wait settles dead with exitCode, a message and the snapshot; kill keeps a tombstone; prune sweeps.",
  issue: 'jahala/umbel#73',
  sink: 'dw.record',
  checks,
};

export default spec;
