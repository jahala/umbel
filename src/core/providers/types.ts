// ---------------------------------------------------------------------------
// Provider abstraction — types.ts
// ---------------------------------------------------------------------------

import type { StartupDialog } from '../startup-dialogs.ts';

export type { StartupDialog };

export interface ProviderLaunchSpec {
  bin: string; // 'claude' | 'codex' | 'gemini' | absolute path
  args: string[]; // launch flags (model, allowedTools, hook config)
  env: Record<string, string>; // env vars to merge into tmux env (provider-specific)
  files: Array<{ path: string; content: string; mode?: number }>;
  //   ↑ ephemeral files to write into the cwd before launch (e.g.
  //   .codex/hooks.json, .gemini/settings.json). Operations layer writes them
  //   and removes them on session kill. Empty for providers that support
  //   inline-config flags (Claude's --settings).
}

// ---------------------------------------------------------------------------
// ActionManifest — structured digest of what a worker DID in a session
// ---------------------------------------------------------------------------
//
// Returned by AgentProvider.extractActions. Normalized across providers so
// the orchestrator gets the same shape whether it's reading from Claude,
// Codex, or Gemini transcripts. Each field is a pure projection of the
// provider's JSONL into a small, agent-consumable summary.
//
// Empty/zero values are valid (e.g. a turn that produced no tool calls
// returns toolsUsed = {}). Implementations MUST NOT throw on malformed
// input — return a partial or empty manifest instead.

export interface ActionManifest {
  // Count of each tool the worker invoked, e.g. { Read: 7, Edit: 3, Bash: 1 }.
  // Keys are the provider's native tool names (Claude uses 'Read'/'Edit'/etc.;
  // Codex/Gemini may use different identifiers — normalized per-provider).
  toolsUsed: Record<string, number>;

  // Absolute or relative file paths the worker read, edited, wrote.
  // Each list is order-of-first-occurrence, deduplicated.
  filesRead: string[];
  filesEdited: string[];
  filesWritten: string[];

  // Bash commands the worker executed, in order. Multi-line commands kept as
  // one string. No deduplication (repetition is meaningful).
  bashCommands: string[];

  // Human-readable error messages extracted from tool_result entries that
  // signal failure (is_error: true for Claude; provider-specific markers for
  // Codex/Gemini). One entry per failed tool call.
  errors: string[];

  // Final assistant text from the most recent completed turn (stop_reason:
  // end_turn for Claude, task_complete event for Codex, AfterAgent boundary
  // for Gemini). Empty string if no completed turn yet.
  finalMessage: string;

  // Number of completed turns observed in the transcript. Zero if no turn
  // has finished.
  turnCount: number;
}

// ---------------------------------------------------------------------------
// Turn — single completed cycle in a session
// ---------------------------------------------------------------------------
//
// Returned by AgentProvider.extractTurns. A turn = everything between one
// user prompt and the assistant's end-of-turn signal. `text` is the final
// assistant text for that turn (matches what parseTranscript would return
// if called against just that turn's slice of the JSONL).
//
// Index is zero-based, in chronological order. Used by operations/diff.ts
// to compute deltas between turns.

export interface Turn {
  index: number;
  text: string;
}

export interface AgentProvider {
  readonly name: string;

  buildLaunch(opts: {
    sessionId: string; // rctrl session name (= tmux session suffix)
    cwd: string;
    hookScriptPath: string; // absolute path to our stop.sh
    notifyScriptPath?: string; // absolute path to our notify.sh (needs-input hook)
    model?: string;
    allowedTools?: string;
  }): ProviderLaunchSpec;

  // Optional: reconcile the fully-assembled worker env immediately before
  // launch. PURE — returns a new env (or the input unchanged); never mutates
  // or throws. Lets a provider resolve mutually-exclusive credential vars:
  // claude drops an inherited ANTHROPIC_API_KEY when a custom ANTHROPIC_AUTH_TOKEN
  // is set, so the worker neither mis-bills nor wedges on the "use this key?"
  // prompt. Omit for providers with no such conflict.
  reconcileEnv?(env: Record<string, string>): Record<string, string>;

  // Which lifecycle event name marks end-of-turn in this provider's hook
  // payload? rctrl's stop.sh is generic — it captures transcript_path from
  // whatever payload it gets. This field is informational + tests.
  readonly stopEventName: string; // 'Stop' for Claude/Codex, 'AfterAgent' for Gemini

  // Extract the final assistant text from the transcript file. Different
  // JSONL/JSON envelopes per provider.
  parseTranscript(content: string): string;

  // Optional: extract a normalized digest of tool calls, files touched, and
  // errors from the transcript. Returned shape is ActionManifest. Pure —
  // never throws on malformed input; returns an empty/partial manifest.
  // Operations layer (rctrl_actions) falls back to a "not implemented for
  // this provider" message when this is undefined.
  extractActions?(content: string): ActionManifest;

  // Optional: split the transcript into completed turns. Each turn carries
  // its final assistant text. Pure — never throws; returns [] for malformed
  // or empty input. Used by operations/diff.ts to compute inter-turn deltas.
  extractTurns?(content: string): Turn[];

  // Optional: providers whose transcript is NOT an on-disk file (e.g. OpenCode,
  // SQLite-backed) declare the argv to run to export it as text. PURE — returns
  // the command; the operations layer executes it. Mutually exclusive with the
  // file-based path (meta.jsonlPath / events/transcript-path).
  exportTranscript?(sessionId: string): readonly string[];

  // Optional: interactive startup dialogs this provider's TUI shows on first
  // launch in a fresh cwd (workspace-trust prompts, hook-review prompts).
  // spawn auto-dismisses them by watching the pane and sending each dialog's
  // keys. Declared in order; later dialogs only appear after earlier ones are
  // dismissed. Omit/empty for providers with no startup dialogs.
  readonly startupDialogs?: readonly StartupDialog[];

  // Optional: a marker that the main UI has rendered (past all dialogs). Lets
  // spawn stop polling early when the cwd is already trusted (no dialogs
  // appear) instead of waiting out the full timeout.
  readonly readyMatch?: RegExp;

  // Optional: milliseconds to wait between pasting the prompt text and sending
  // the submitting Enter. Codex's TUI drops an Enter that arrives too soon
  // after the paste (the prompt sits in the box unsent); a short delay lets it
  // ingest the text first. Claude submits fine with no delay (omit → 0).
  readonly submitDelayMs?: number;

  // For providers without hook lifecycle (aider): anchor-string fallback.
  // Mutually exclusive with hook-based completion; the operations layer
  // checks this field to choose its wait strategy.
  readonly anchorStrategy?: {
    sentinel: string; // e.g. '<<<RCTRL_DONE_8e2a>>>'
    promptSuffix: string; // appended to user prompts so the model
    // is instructed to emit the sentinel
  };

  // Optional: a one-time global plugin to install alongside stop.sh.
  // Provider declares the file name and content; the hooks adapter writes it
  // to hooksDir and merges its absolute path into the provider's config file.
  // Pure — no I/O here; the adapter owns installation.
  readonly globalPlugin?: {
    readonly fileName: string;
    readonly content: string;
  };
}
