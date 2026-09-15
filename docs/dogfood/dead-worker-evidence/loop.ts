import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  'Ground truth, read before coding: src/adapters/tmux.ts — newSession runs tmux new-session -d -s <prefixed name> -c cwd [-e K=V…] -- cmd on umbel\'s private socket (tmuxArgs); hasSession is has-session; killSession is kill-session and swallows no-such-session; capturePane is capture-pane; sendKeys/sendText send input. src/operations/wait.ts probes liveness every 500 ms through hasSession and settles {reason: dead, paneSnapshot: lastAlivePane} where lastAlivePane is refreshed every ALIVE_PANE_CAPTURE_MS while alive (#63). src/operations/spawn.ts checks hasSession after launch and throws SessionNotCreatedError otherwise. src/operations/kill.ts: killSession, then unless removeState === false unlink meta.providerFiles and d.fs.rmSession — the directory is gone. src/adapters/fs-state.ts owns sessionDir/eventsDir/readMeta/writeMeta/rmSession/listSessionNames under $UMBEL_STATE/sessions/<name>/ with meta.json and events/{stop,log,notification,transcript-path,quota,session-id}. src/operations/status.ts enrich(): alive = hasSession, lastActivityAt from events/log, needsInput from events/notification, quota; ls and status print it in src/faces/cli.ts. capture (cli) calls capturePane and fails with tmux\'s no server running when the session is gone; read goes through resolve-transcript.ts and throws SessionDeadError when the path is unresolved; logs tails events/log; actions parses the transcript. Fakes: test/fixtures/fake-claude.sh reads prompts from stdin, writes the JSONL transcript, fires the stop hook via FAKE_CLAUDE_HOOK, honours FAKE_CLAUDE_DELAY. tmux facts: set-option -t <session> remain-on-exit on keeps a pane after its process exits; display-message -p -t <target> \'#{pane_dead} #{pane_dead_status}\' prints 1 and the exit status for a dead pane (0 and empty for a live one); capture-pane works on a dead pane; kill-session removes it. Check the installed tmux version with tmux -V before relying on an option. Typed errors in src/core/errors.ts, exit codes in src/faces/cli.ts.',
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'dw.pane',
    claim:
      'A worker\'s tmux pane outlives its process: `newSession` sets `remain-on-exit`, `paneState` reports `{dead: true, exitCode}` after the process exits while the session still exists, and `spawn`\'s startup check and `wait`\'s liveness probe read `paneState`, not `has-session`',
    evidence: 'test/integration/tmux-remain-on-exit.test.ts',
    needs: [],
    how: `tmux.ts: newSession sets remain-on-exit on the session right after new-session; add paneState(name, env): Promise<{exists: boolean; dead: boolean; exitCode?: number}> from display-message -p '#{pane_dead} #{pane_dead_status}' (exists false when the session is gone). spawn's startup check and wait's liveness probe treat !exists || dead as dead. Tests on the real private-socket tmux with UMBEL_STATE in a tmp dir: newSession running sh -c 'echo hi; exit 3' → shortly after, hasSession true, paneState {exists: true, dead: true, exitCode: 3}, capturePane still returns hi; killSession removes it; a live sleep session reports dead false. Then through spawn() with a fake that exits at once (FAKE_CLAUDE_EXIT_AT_START=3, add it) spawn throws SessionNotCreatedError naming the exit code. ${GROUND}`,
  },
  {
    n: 2,
    id: 'dw.wait',
    claim:
      'When the worker dies mid-turn, `wait` settles `dead` with `exitCode`, a `message` naming the exit status, and an exact `paneSnapshot` taken from the dead pane; writes `events/dead` ({at, exitCode, paneSnapshot}) into the session directory; and `status` and `ls` show `dead (exit N)`',
    evidence: 'test/integration/wait-dead-evidence.test.ts',
    needs: ['dw.pane'],
    how: `Fake-claude: FAKE_CLAUDE_DIE_MS and FAKE_CLAUDE_EXIT_CODE — mid-turn print dying now, sleep that long, exit with that code (no hook). wait: on paneState dead, capture the dead pane (exact, no longer the throttled lastAlivePane — keep that as the fallback when the capture fails) and settle {reason: dead, exitCode, message: e.g. process exited 3 (or killed by SIGTERM when the status is a signal), paneSnapshot} — the reason and exit code 125 stay as the runner contract lists them; write events/dead as one JSON object {at, exitCode, paneSnapshot} through a small fs-state addition (writeDead/readDead). WaitResult gains exitCode?: number; the CLI's --json for dead carries it. status.ts: alive from paneState; when the pane is dead or events/dead exists, entry.dead = {exitCode?, at}; ls prints dead (exit 3) in STATUS and status prints the same. Tests through spawn()+send()+waitFor()+status(): reason dead, exitCode 3, paneSnapshot containing dying now; events/dead on disk with the same; status/ls output naming exit 3. ${GROUND}`,
  },
  {
    n: 3,
    id: 'dw.kill',
    claim:
      '`kill` writes `events/dead` ({at, by: \'kill\', paneSnapshot} captured before the session is torn down) and keeps the session directory; `kill --purge` removes it; for a dead session `capture` answers from the pane while it remains and from `events/dead` after, and `logs`, `actions` and `read` answer from the kept directory',
    evidence: 'test/integration/kill-tombstone.test.ts',
    needs: ['dw.wait'],
    how: `kill.ts: before killSession, if the session exists capture the pane and paneState and write events/dead {at, by: 'kill', exitCode?, paneSnapshot} (when wait already wrote one, keep its fields and add by); unlink providerFiles as today (they live in the project cwd, not in the tombstone); rmSession only when opts.purge. KillOpts: purge?: boolean replaces removeState (update every caller: cli, MCP, workflow). cli: kill --purge; the MCP kill tool gets purge. capture: when capturePane fails because the session is gone, answer from events/dead's paneSnapshot and say so on stderr; logs and actions read the kept directory as today; read resolves the transcript from meta.jsonlPath or events/transcript-path as today (a worker that died before its first Stop has none — SessionDeadError stays honest). Tests: kill a live fake → directory kept with events/dead by kill and a snapshot; kill --purge → directory gone; after a completed turn then kill: capture, logs, actions and read all answer. Say in Tried that callers which kill on failure (pleach) now leave tombstones and that prune (next check) sweeps them. ${GROUND}`,
  },
  {
    n: 4,
    id: 'dw.prune',
    claim:
      '`umbel prune [--older-than DURATION]` removes dead sessions\' directories and tmux remains and never touches a live session; docs/cli-reference.md states the lifecycle — the pane kept after death, `exitCode` on `dead`, the tombstone, `--purge`, `prune`',
    evidence: 'test/integration/prune.test.ts',
    needs: ['dw.kill'],
    how: `New verb prune in src/operations/prune.ts (+ cli + MCP): for each session directory, paneState; when the session is gone or its pane is dead, and events/dead's at (or meta's createdAt) is older than --older-than (default: everything dead), killSession (idempotent) and rmSession; live sessions are skipped; return {removed, kept}. Docs: docs/cli-reference.md — the wait section's dead row gains exitCode and the exact snapshot; kill gains --purge; a prune section; a short Lifecycle paragraph (pane kept after death, tombstone, purge, prune); the exit-code table unchanged. Tests: prune removes a dead fake's directory and tmux remains and not a live one; --older-than 1h leaves a fresh tombstone; a docs pin (exitCode, --purge, prune, kept after death). ${GROUND}`,
  },
  {
    n: 5,
    id: 'dw.e2e',
    claim:
      'Through the CLI with a fake that exits 3 mid-turn: `wait --json` exits 125 with `{"reason":"dead","exitCode":3,"message":…,"paneSnapshot":…}`, `capture`, `logs` and `read` still answer, `kill` leaves the directory with `events/dead`, `kill --purge` removes it, and `prune` sweeps a killed session',
    evidence: 'test/e2e/dead-worker.test.ts',
    needs: ['dw.prune'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/cli.test.ts. One fake worker that completes a turn, then a second prompt during which it dies with exit 3: wait --json → exit 125 and JSON with reason dead, exitCode 3, a paneSnapshot containing the fake's last line; capture, logs and read answer afterwards; kill → directory still there with events/dead; kill --purge → gone; a second worker killed live → prune sweeps it and reports one removed. Also update the smoke helper's cleanup (test/smoke/helpers.ts makeCleanupGuard) to kill --purge so smokes stop leaving tombstones. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/dead-worker-evidence.tend2.html',
  payload: '6a945d73a510',
  title: 'A dead worker leaves its evidence',
  goal: 'A worker that dies leaves what a post-mortem needs: its tmux pane outlives its process (remain-on-exit), so umbel reads the exact last screen and the exit status; wait settles dead with both and writes events/dead; capture, logs, actions and read keep answering; kill leaves a tombstone unless --purge; prune sweeps tombstones.',
  issue: 'jahala/umbel#73',
  sink: 'dw.e2e',
  checks,
};

export default spec;
