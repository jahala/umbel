// Embedded help content surfaced via the `umbel_help` MCP tool. Kept here
// (not read from docs/) so the single-binary build self-contains everything,
// no runtime file I/O is needed, and content can be agent-curated (tighter
// than human-facing docs/). Drift against docs/ is sanity-checked by tests.

export const HELP_TOPICS = ['lifecycle', 'workflow', 'providers'] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

const LIFECYCLE = `# umbel lifecycle

Verbs are short-lived. Per-session state lives in $UMBEL_STATE/sessions/<name>/ (default ~/.umbel/).

## spawn → send → wait → read → kill

- spawn: starts a tmux session running the provider TUI; returns the session name.
- send: enqueues a prompt via tmux paste-buffer. Returns immediately. Does NOT wait.
- wait: blocks until a condition is met. Default: Stop hook fires (end-of-turn).
- read: returns the last assistant message from the session's transcript file. Call AFTER wait.
- kill: tears down the tmux session and clears state. Pass keepState=true to preserve for inspection.

## Anonymous vs named

  umbel_spawn { cwd } → anonymous (auto-named, kill yourself when done)
  umbel_spawn { cwd, name: "reviewer" } → named, persists across calls

## Typical orchestration

  const { content } = await tools.umbel_spawn({ cwd: "/repo", name: "rev", provider: "claude" });
  const { name } = JSON.parse(content[0].text);
  await tools.umbel_send({ name, prompt: "Review PR #42" });
  await tools.umbel_wait({ name, until: "stop", timeout: "10m" });
  const { content: r } = await tools.umbel_read({ name });
  // r[0].text contains the assistant's response
  await tools.umbel_kill({ name, keepState: false });

## Wait kinds (umbel_wait \`until\` field)

  until: "stop"     → end-of-turn (default; Stop hook fired)
  until: "file"     → file appears at \`file\` path
  until: "pattern"  → regex matches a line in the tmux pane

## Wait outcomes (the \`reason\` field in the result)

umbel_wait returns { reason, message?, paneSnapshot? }. Branch on reason:
  stop   → turn complete; umbel_read the result.
  input  → the worker is BLOCKED on a prompt (a permission ask, or idle). \`message\`
           is the question — answer it with umbel_send ("1", "yes", or a
           clarification), then umbel_wait again. This is the ping: you do NOT hang
           to the timeout when a worker needs you.
  idle   → no pane activity for idle_timeout. Pass idle_timeout: "3m" to enable this
           net (off by default — a worker may run a long silent tool call). Inspect
           paneSnapshot, then re-wait / nudge / kill.
  dead   → the worker exited without finishing. Respawn or fail.
  timeout→ hard deadline hit; paneSnapshot shows the stuck pane.

For poll-style control of a fleet, umbel_status carries needsInput + needsInputReason (permission/idle/question) per worker — the same disambiguation without a blocking wait. Tip: a worker reaching for a tool NOT in allowedTools wedges on a permission prompt (now surfaced as reason permission) — allowlist the project's MCP read-only tools at spawn to avoid it. (Write does not imply Edit.)

## Interrupt discipline

A single expected reason:input can be answered with umbel_send, then umbel_wait again. Repeated input prompts during one turn are usually a permission storm or nested workflow asking for supervision; do not keep approving blindly. Pause, inspect umbel_status/umbel_capture, narrow the prompt or allowedTools, or kill and use a simpler worker/host tool.

Treat reason:dead, "Connection closed", or a vanished tmux session as failure, not completion. Inspect umbel_logs and umbel_capture/status before moving on.

## Critical rule

Pair every umbel_send with a umbel_wait. Sending without waiting causes your next umbel_read to return the previous turn's response, not the current one. The Stop hook is the only deterministic end-of-turn signal — do not infer completion from tmux pane content.

## Reading worker output efficiently

- \`umbel_read\` returns the verbatim final assistant text. Long responses (>~2000 tokens) auto-truncate to head+tail with an elision marker. Override with \`full: true\` to see everything, or \`head\`/\`tail\` (approx token counts) / \`section: "## Heading"\` to control the window.
- \`umbel_actions\` returns a structured digest (tools used, files touched, errors, final message). The right shape for "what HAPPENED?" — easier to scan than verbatim text and surfaces info umbel_read doesn't (file paths touched, bash commands run, error count). Default reach for orchestration.
- \`umbel_diff\` returns a unified text diff between two turns of a session. Default: latest vs previous. Indispensable in review→fix loops — you see only what's NEW, not the prefix the reviewer keeps repeating.

When orchestrating multiple workers, prefer umbel_actions per worker and only escalate to umbel_read when you need the verbatim text. In iterative loops, use umbel_diff to track the delta between turns.`;

const WORKFLOW = `# umbel workflow YAML

For multi-step, multi-worker pipelines. Schema is validated by WorkflowSpecSchema in src/core/types.ts.

## Top-level shape

  workers:
    <name>:
      cwd: string                   # required; must exist before \`umbel run\`
      provider: claude|codex|gemini|opencode # default: claude
      model: string                 # optional; provider validates at spawn
      allowedTools: string          # optional; comma-separated

  steps:
    - run: <worker-name>            # required
      prompt: string                # required; supports {{ }} substitution
      wait: WaitCondition           # optional; default: any[stop $session, timeout 30m]
      outputs: { key: OutputSpec }  # optional
      needs: [<worker-name>]        # optional; topological ordering

## Wait conditions

  { kind: stop, session: "name" }
  { kind: file, path: "./done.txt" }
  { kind: pattern, session: "name", regex: "All tests passed" }
  { kind: timeout, ms: 600000 }
  { kind: all, conditions: [ ... ] }
  { kind: any, conditions: [ ... ] }

Shorthand: \`wait: { stop: $session }\` expands to \`{ kind: stop, session: <current step's worker> }\`.

## Output capture

  outputs:
    review: file:./worktrees/review/review.md   # read file contents
    summary: assistant_last_message             # read transcript

Captured outputs flow downstream via \`{{ steps.NAME.outputs.KEY }}\`.

## Templating (intentionally minimal — variable substitution only)

  {{ env.X }}                  # env var at \`umbel run\` time
  {{ steps.NAME.outputs.KEY }} # captured output (requires \`needs: [NAME]\`)
  {{ $session }}               # current step's worker name

No expressions, conditionals, or loops. For control flow, wrap umbel in a shell script.

## Parallelism

Steps with no unsatisfied \`needs:\` run concurrently in the same wave. Cycles in \`needs:\` are rejected at parse time.

## Example

  workers:
    reviewer: { cwd: ./worktrees/review, provider: claude, model: sonnet }
    fixer:    { cwd: ./worktrees/fix,    provider: codex,  model: o4-mini }

  steps:
    - run: reviewer
      prompt: "Review PR #{{ env.PR }}. Write findings to review.md."
      outputs: { findings: file:./worktrees/review/review.md }
    - run: fixer
      needs: [reviewer]
      prompt: "Apply these fixes:\\n{{ steps.reviewer.outputs.findings }}"
      wait: { all: [ { stop: $session }, { file: ./worktrees/fix/tests-passed } ] }

Run: \`umbel run pipeline.yaml\`.`;

const PROVIDERS = `# umbel providers

Pluggable interface — same orchestration over four vendor CLIs.

## Subscription billing vs bring-your-own-model

Claude, Codex, and Gemini are subscription-billed (umbel drives their interactive TUI).
OpenCode is NOT subscription-billed — it is: local (ollama/…, free), free-tier (opencode/big-pickle, keyless but limited), or API-billed (your own key for anthropic/… or openrouter/…). OpenCode is the bring-any-model lane, not a cheaper path to cloud models.

## Per-vendor specifics

Claude (\`provider: claude\`)
- Hook config delivered inline via \`--settings '<json>'\` (no file write).
- stopEventName: "Stop". Trust dialog auto-dismissed on first launch in a fresh cwd.
- Flags: --model <name>, --allowedTools "Read,Write,...".
- Custom endpoint: target any Anthropic-compatible API (DeepSeek, OpenRouter, local proxy) by giving the worker ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + ANTHROPIC_MODEL (+ ANTHROPIC_SMALL_FAST_MODEL for background calls) — via inherited env, --env / env:, or {fromEnv} references (resolved from the umbel server's env, so a secret never enters the caller's transcript). Use AUTH_TOKEN not API_KEY: umbel drops an inherited ANTHROPIC_API_KEY when a custom AUTH_TOKEN is set (else it shadows the endpoint and wedges the worker on the "use this key?" prompt). Same hooks/transcript — still Claude Code, a different brain. Billed per-token by that endpoint, NOT a Claude subscription. status reports the effective baseUrl.

Codex (\`provider: codex\`)
- Hook config delivered via <cwd>/.codex/hooks.json (written at spawn, removed at kill).
- stopEventName: "Stop". transcript_path may be null per Codex docs; umbel falls back to dir-snapshot.
- Hazard: umbel OVERWRITES any pre-existing <cwd>/.codex/hooks.json. If the user has their own Codex hooks config there, it will be replaced on spawn and not restored. v4 plan is CODEX_HOME-style out-of-cwd config.

Gemini (\`provider: gemini\`)
- Hook config delivered via <cwd>/.gemini/settings.json.
- stopEventName: "AfterAgent" (not "Stop"). matcher: "*". Timeout in ms (Codex uses seconds).
- Same overwrite hazard as Codex.

OpenCode (\`provider: opencode\`)
- Hook delivered via a bundled JS plugin installed ONCE into the user's global opencode config (~/.config/opencode/). NOT per-cwd, NOT per-session — no worktree mutation, crash-safe, reversible. Inert unless UMBEL_SESSION_ID is set.
- No JSONL transcript (SQLite only). Output read via \`opencode export <sessionID>\`.
- stopEventName: "session.status" idle (plugin-based).
- Model flag: -m provider/model. Examples: opencode/big-pickle (free keyless Zen), ollama/qwen2.5-coder (local), openrouter/deepseek/deepseek-v4-flash (cloud, needs your OPENROUTER_API_KEY).
- API keys reach the worker via inherited env or --env KEY=VAL; umbel does not manage keys.

## When to mix providers

- Claude for orchestration/architecture, Codex for code completion in a tight loop, Gemini for analysis or summarization.
- Use an opencode/ollama worker as a free local laborer alongside subscription workers.
- Run the same task against two providers concurrently and have an arbitrator pick the better output.

## Model names

Free-form strings. Each provider validates at spawn time. umbel does not enforce names.

  claude: "sonnet", "opus", "haiku"
  codex:  "o4-mini", "gpt-4.1", ...
  gemini: "gemini-2.5-pro", "gemini-2.5-flash", ...
  opencode: "opencode/big-pickle", "ollama/qwen2.5-coder", "anthropic/claude-sonnet-4-5", "openrouter/deepseek/deepseek-v4-flash"`;

const TOPIC_CONTENT: Record<HelpTopic, string> = {
  lifecycle: LIFECYCLE,
  workflow: WORKFLOW,
  providers: PROVIDERS,
};

const INDEX = `umbel_help topics:

  lifecycle  — spawn/send/wait/read/kill verb contracts and typical orchestration
  workflow   — YAML schema for multi-step pipelines (umbel run)
  providers  — per-vendor specifics for claude/codex/gemini/opencode

Call umbel_help with { topic: "<name>" } for a topic. Omit topic for this index.`;

export function helpForTopic(topic?: string): string {
  if (topic === undefined) return INDEX;
  if ((HELP_TOPICS as readonly string[]).includes(topic)) {
    return TOPIC_CONTENT[topic as HelpTopic];
  }
  return `Unknown umbel_help topic: "${topic}". Available: ${HELP_TOPICS.join(', ')}.`;
}
