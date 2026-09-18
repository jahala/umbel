# Worker environment without argv (umbel#93)

## The leak

`spawn` handed the whole composed environment to tmux as `new-session -e KEY=VALUE`, one flag per
variable. Every value sat on the tmux client's argv, and the tmux server, forked from the first
`new-session` client, keeps that argv for its whole life. Every worker's keys were readable with
`ps`. A provider key leaked this way and has to be rotated.

There is a second channel the issue does not name. The tmux server starts with the full
environment of whichever spawn launched it, and every later pane inherits that global environment.
So each worker also received the first spawner's environment, secrets included, and a denylist or
allowlist applied only to `-e` would have changed nothing.

`umbel spawn --env KEY=VALUE`, the documented CLI recipe for a custom endpoint, puts the secret on
umbel's own argv. pleach builds exactly that argv for its per-worker env.

## Decision

The environment travels through a tmux buffer, and only what a worker needs travels at all.

1. **Channel.** spawn renders the worker's environment as single-quoted `export` lines and feeds
   them on stdin to `load-buffer -b umbel-env-<name> -`, chained in the same tmux invocation ahead
   of `new-session`, so the buffer exists before the pane runs even when that invocation starts the
   server. The pane runs the launch wrapper with the buffer's name as its first argument. The
   wrapper reads the buffer with `tmux show-buffer`, deletes it, clears every exported variable it
   inherited except the ones tmux sets for the pane (`TERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`,
   `COLORTERM`, `TMUX`, `TMUX_PANE`), evaluates the exports, and runs the worker. A spawn that
   unwinds deletes the buffer. No `-e` flags.

   A buffer rather than a file, because a file holding the environment is a secret on disk, and
   removing it safely is harder than never writing it. The buffer lives in the tmux server's memory,
   behind the same private socket as the workers, for as long as the wrapper takes to start.

   The wrapper is installed as `hooks/launch.sh`, not over `hooks/exec.sh`. Every spawn rewrites its
   wrapper, and long-running MCP servers still hold older umbel code: an old spawn under the new
   wrapper would read the provider binary's path as a buffer name, and a new spawn under the old
   wrapper would try to run the buffer name. Separate names let both versions run side by side.
2. **tmux's own environment.** Every tmux invocation runs with a minimal environment, so a server
   umbel starts holds no caller variables to hand to panes or show in the process table. The
   wrapper's clearing covers servers started before this change.
3. **What travels.** A base allowlist of operational, non-secret variables (paths, locale,
   `XDG_*`, proxies, CA bundles, `SSH_AUTH_SOCK`), plus the configuration variables each provider
   names (claude `ANTHROPIC_*` and `CLAUDE_CONFIG_DIR`, codex `OPENAI_*`, gemini `GEMINI_API_KEY`
   and `GOOGLE_*`, the full list in cli-reference), plus everything passed explicitly. Explicit
   wins, as before.

   Configuration is named variable by variable, never as a whole vendor prefix. The first cut
   inherited `CLAUDE_*`, and that prefix also holds the markers a host Claude Code session sets
   for its children. A worker launched from inside Claude Code inherited
   `CLAUDE_CODE_CHILD_SESSION`, took itself for a child session and turned its transcript off, so
   `read` found nothing. Every provider's binary names markers of this kind (`GEMINI_CLI`,
   `OPENCODE_PID`), so all four name their configuration instead.
4. **CLI.** `--env NAME` without `=` passes `NAME` through from umbel's own environment, so a caller
   never has to put a secret on any argv. `--env NAME=VALUE` still works for non-secrets.

This reverses the earlier decision to inherit everything minus a denylist. That decision was right
about the cost of a narrow allowlist (the old 7-variable list stripped proxies and config dirs), so
this allowlist keeps those, and keeps the documented inheritance recipe working for the provider's
own variables. What stops travelling is everything else in the caller's environment: unrelated keys,
tokens and credentials.

A caller that relied on inheritance for anything outside the allowlist now passes it by name. pleach
is one: it should export each per-worker secret and pass `--env NAME`, never `--env NAME=VALUE`.

## Why this might be wrong

- A worker needs a variable outside the allowlist and fails confusingly. Mitigation: the allowlist
  covers what the old narrow list got wrong, provider config names cover the usual setups, and
  `--env NAME` is a one-token fix. Documented in cli-reference.
- Clearing the environment in the wrapper drops something tmux sets that a TUI needs. `TERM` is kept;
  a real-binary spawn is part of the proof.
- A value contains characters that break the exports. Single quotes with `'\''` escaping round-trip
  any byte except NUL, which an environment value cannot hold. A variable whose name is not a shell
  identifier cannot be exported by any shell and is skipped.
- Someone reads the buffer before the wrapper deletes it. Only the socket's owner can, and that user
  can already read the worker's environment and transcripts.

## Proof

`test/integration/worker-env.test.ts` samples every process's argv from before the spawn until the
worker is up. A canary the worker is not given, planted in umbel's environment, appears in no argv,
in neither the tmux server's nor the session's environment, nowhere the worker can read, and in no
file under the state dir. A canary passed explicitly reaches the worker, and appears in no argv, no
tmux environment and no file under the state dir. Both assertions fail against the code before this
change. Then a real worker run through the installed binary with canaries.
