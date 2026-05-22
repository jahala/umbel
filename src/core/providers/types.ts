// ---------------------------------------------------------------------------
// Provider abstraction — types.ts
// ---------------------------------------------------------------------------

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

export interface AgentProvider {
  readonly name: string;

  buildLaunch(opts: {
    sessionId: string; // rctrl session name (= tmux session suffix)
    cwd: string;
    hookScriptPath: string; // absolute path to our stop.sh
    model?: string;
    allowedTools?: string;
  }): ProviderLaunchSpec;

  // Which lifecycle event name marks end-of-turn in this provider's hook
  // payload? rctrl's stop.sh is generic — it captures transcript_path from
  // whatever payload it gets. This field is informational + tests.
  readonly stopEventName: string; // 'Stop' for Claude/Codex, 'AfterAgent' for Gemini

  // Extract the final assistant text from the transcript file. Different
  // JSONL/JSON envelopes per provider.
  parseTranscript(content: string): string;

  // For providers without hook lifecycle (aider): anchor-string fallback.
  // Mutually exclusive with hook-based completion; the operations layer
  // checks this field to choose its wait strategy.
  readonly anchorStrategy?: {
    sentinel: string; // e.g. '<<<RCTRL_DONE_8e2a>>>'
    promptSuffix: string; // appended to user prompts so the model
    // is instructed to emit the sentinel
  };
}
