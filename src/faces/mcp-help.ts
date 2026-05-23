// Embedded help content surfaced via the `rctrl_help` MCP tool. Kept here
// (not read from docs/) so the single-binary build self-contains everything,
// no runtime file I/O is needed, and content can be agent-curated (tighter
// than human-facing docs/). Drift against docs/ is sanity-checked by tests.

export const HELP_TOPICS = ['lifecycle', 'workflow', 'providers'] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

const LIFECYCLE = `# rctrl lifecycle

Verbs are short-lived. Per-session state lives in $RCTRL_STATE/sessions/<name>/ (default ~/.rctrl/).

## spawn → send → wait → read → kill

- spawn: starts a tmux session running the provider TUI; returns the session name.
- send: enqueues a prompt via tmux paste-buffer. Returns immediately. Does NOT wait.
- wait: blocks until a condition is met. Default: Stop hook fires (end-of-turn).
- read: returns the last assistant message from the session's transcript file. Call AFTER wait.
- kill: tears down the tmux session and clears state. Pass keepState=true to preserve for inspection.

## Anonymous vs named

  rctrl_spawn { cwd } → anonymous (auto-named, kill yourself when done)
  rctrl_spawn { cwd, name: "reviewer" } → named, persists across calls

## Typical orchestration

  const { content } = await tools.rctrl_spawn({ cwd: "/repo", name: "rev", provider: "claude" });
  const { name } = JSON.parse(content[0].text);
  await tools.rctrl_send({ name, prompt: "Review PR #42" });
  await tools.rctrl_wait({ name, until: "stop", timeout: "10m" });
  const { content: r } = await tools.rctrl_read({ name });
  // r[0].text contains the assistant's response
  await tools.rctrl_kill({ name, keepState: false });

## Wait kinds (rctrl_wait \`until\` field)

  until: "stop"     → end-of-turn (default; Stop hook fired)
  until: "file"     → file appears at \`file\` path
  until: "pattern"  → regex matches a line in the tmux pane

## Critical rule

Pair every rctrl_send with a rctrl_wait. Sending without waiting causes your next rctrl_read to return the previous turn's response, not the current one. The Stop hook is the only deterministic end-of-turn signal — do not infer completion from tmux pane content.`;

const WORKFLOW = `# rctrl workflow YAML

For multi-step, multi-worker pipelines. Schema is validated by WorkflowSpecSchema in src/core/types.ts.

## Top-level shape

  workers:
    <name>:
      cwd: string                   # required; must exist before \`rctrl run\`
      provider: claude|codex|gemini # default: claude
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

  {{ env.X }}                  # env var at \`rctrl run\` time
  {{ steps.NAME.outputs.KEY }} # captured output (requires \`needs: [NAME]\`)
  {{ $session }}               # current step's worker name

No expressions, conditionals, or loops. For control flow, wrap rctrl in a shell script.

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

Run: \`rctrl run pipeline.yaml\`.`;

const PROVIDERS = `# rctrl providers

Pluggable interface — same orchestration over three vendor CLIs.

## Per-vendor specifics

Claude (\`provider: claude\`)
- Hook config delivered inline via \`--settings '<json>'\` (no file write).
- stopEventName: "Stop". Trust dialog auto-dismissed on first launch in a fresh cwd.
- Flags: --model <name>, --allowedTools "Read,Write,...".

Codex (\`provider: codex\`)
- Hook config delivered via <cwd>/.codex/hooks.json (written at spawn, removed at kill).
- stopEventName: "Stop". transcript_path may be null per Codex docs; rctrl falls back to dir-snapshot.
- Hazard: rctrl OVERWRITES any pre-existing <cwd>/.codex/hooks.json. If the user has their own Codex hooks config there, it will be replaced on spawn and not restored. v4 plan is CODEX_HOME-style out-of-cwd config.

Gemini (\`provider: gemini\`)
- Hook config delivered via <cwd>/.gemini/settings.json.
- stopEventName: "AfterAgent" (not "Stop"). matcher: "*". Timeout in ms (Codex uses seconds).
- Same overwrite hazard as Codex.

## When to mix providers

- Claude for orchestration/architecture, Codex for code completion in a tight loop, Gemini for analysis or summarization.
- Run the same task against two providers concurrently and have an arbitrator pick the better output.
- Use Claude for sensitive paths (privacy/compliance) and Codex/Gemini for non-sensitive ones.

## Model names

Free-form strings. Each provider validates at spawn time. rctrl does not enforce names — what's valid depends on your subscription tier.

  claude: "sonnet", "opus", "haiku"
  codex:  "o4-mini", "gpt-4.1", ...
  gemini: "gemini-2.5-pro", "gemini-2.5-flash", ...`;

const TOPIC_CONTENT: Record<HelpTopic, string> = {
  lifecycle: LIFECYCLE,
  workflow: WORKFLOW,
  providers: PROVIDERS,
};

const INDEX = `rctrl_help topics:

  lifecycle  — spawn/send/wait/read/kill verb contracts and typical orchestration
  workflow   — YAML schema for multi-step pipelines (rctrl run)
  providers  — per-vendor specifics for claude/codex/gemini

Call rctrl_help with { topic: "<name>" } for a topic. Omit topic for this index.`;

export function helpForTopic(topic?: string): string {
  if (topic === undefined) return INDEX;
  if ((HELP_TOPICS as readonly string[]).includes(topic)) {
    return TOPIC_CONTENT[topic as HelpTopic];
  }
  return `Unknown rctrl_help topic: "${topic}". Available: ${HELP_TOPICS.join(', ')}.`;
}
