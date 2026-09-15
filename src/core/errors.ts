export class SessionNotFoundError extends Error {
  override name = 'SessionNotFoundError';

  constructor(public sessionName: string) {
    super(`Session not found: ${sessionName}`);
  }
}

export class SessionDeadError extends Error {
  override name = 'SessionDeadError';

  constructor(
    public sessionName: string,
    public reason: string,
  ) {
    super(`Session dead: ${sessionName} — ${reason}`);
  }
}

export class HookTimeoutError extends Error {
  override name = 'HookTimeoutError';

  constructor(public waitedMs: number) {
    super(`Hook timed out after ${waitedMs}ms`);
  }
}

export class TmuxError extends Error {
  override name = 'TmuxError';

  constructor(
    public cmd: string,
    public stderr: string,
  ) {
    super(`tmux ${cmd} failed: ${stderr}`);
  }
}

export class JsonlMalformedError extends Error {
  override name = 'JsonlMalformedError';

  constructor(public path: string) {
    super(`Malformed JSONL at: ${path}`);
  }
}

export class WorkflowCycleError extends Error {
  override name = 'WorkflowCycleError';

  constructor(public workers: string[]) {
    super(`Workflow cycle detected: ${workers.join(' → ')}`);
  }
}

export class WaitTimeoutError extends Error {
  override name = 'WaitTimeoutError';

  constructor(public condition: unknown) {
    super('Wait condition timed out');
  }
}

export class UmbelUsageError extends Error {
  override name = 'UmbelUsageError';
}

export class ProviderUnknownError extends Error {
  override name = 'ProviderUnknownError';

  constructor(
    public providerName: string,
    validProviders?: readonly string[],
  ) {
    const valid =
      validProviders !== undefined && validProviders.length > 0
        ? `. Valid providers: ${validProviders.join(', ')}`
        : '';
    super(`Unknown provider: ${providerName}${valid}`);
  }
}

export class EnvRefUnresolvedError extends Error {
  override name = 'EnvRefUnresolvedError';

  constructor(
    public key: string,
    public sourceVar: string,
  ) {
    super(`env ${key}: {fromEnv: "${sourceVar}"} — source variable ${sourceVar} is not set`);
  }
}

export class WorkerBlockedError extends Error {
  override name = 'WorkerBlockedError';

  constructor(
    public sessionName: string,
    public detail: string,
  ) {
    super(`Worker blocked waiting for input: ${sessionName} — ${detail}`);
  }
}

export class AllowedToolsUnsupportedError extends Error {
  override name = 'AllowedToolsUnsupportedError';

  constructor(public providerName: string) {
    super(
      `--allowed-tools is not supported by provider '${providerName}'. Only 'claude' supports it.`,
    );
  }
}

export class UnattendedUnsupportedError extends Error {
  override name = 'UnattendedUnsupportedError';

  constructor(public providerName: string) {
    super(
      `Provider '${providerName}' has no unattended mode: it would prompt a human who isn't there. ` +
        'Refused at spawn rather than wedging on the prompt later.',
    );
  }
}

// `tmux new-session -d` exits 0 once the server accepts the command, which is
// not the same as the session existing afterwards: with no server already
// running (under nohup, systemd, a detached CI step) the server can fail to
// survive detachment and take the session with it. Reported as umbel#54.
export class SessionNotCreatedError extends Error {
  override name = 'SessionNotCreatedError';

  constructor(public sessionName: string) {
    super(
      `Session ${sessionName} was not created: tmux reported success but no session exists. ` +
        'Most likely no tmux server could be started in this environment — check that the ' +
        'socket directory is writable (TMUX_TMPDIR) when running detached (nohup/systemd).',
    );
  }
}

// The user's opencode.jsonc is theirs: when it does not parse, the spawn is
// refused and the file left untouched rather than replaced (umbel#53).
export class OpencodeConfigUnparsableError extends Error {
  override name = 'OpencodeConfigUnparsableError';

  constructor(
    public file: string,
    public line: number,
    public column: number,
    public reason: string,
  ) {
    super(
      `${file}:${line}:${column}: not valid JSONC (${reason}). ` +
        'umbel left the file untouched; fix it, or move it aside, and spawn again.',
    );
  }
}

// opencode falls back to another model when -m names one it does not know, so
// an unlisted model is refused before a worker exists (umbel#53).
const LISTED_MODELS_SHOWN = 10;

export class OpencodeModelUnknownError extends Error {
  override name = 'OpencodeModelUnknownError';

  constructor(
    public model: string,
    public listed: readonly string[],
  ) {
    const shown = listed.slice(0, LISTED_MODELS_SHOWN).join(', ');
    const more =
      listed.length > LISTED_MODELS_SHOWN
        ? ` and ${listed.length - LISTED_MODELS_SHOWN} more (run \`opencode models\`)`
        : '';
    super(
      `Unknown model: ${model}. opencode lists ${listed.length === 0 ? 'no models' : `${shown}${more}`}.`,
    );
  }
}

// A model list umbel could not read means umbel cannot vouch for the model, so
// the spawn is refused rather than launched on a guess.
export class ModelListUnavailableError extends Error {
  override name = 'ModelListUnavailableError';

  constructor(
    public model: string,
    public detail: string,
  ) {
    super(`Cannot check model ${model}: listing models failed. ${detail.trim()}`);
  }
}

// The worker kept the prompt in its input box through every Enter send is
// allowed to press, so no turn began (jahala/umbel#77). The pane is carried so
// the caller sees what the worker shows; the session is left alive.
export class SendNotSubmittedError extends Error {
  override name = 'SendNotSubmittedError';

  constructor(
    public sessionName: string,
    public paneSnapshot: string,
    public enters: number,
    public pendingLine: string,
  ) {
    super(
      `Prompt not submitted to ${sessionName}: input still pending (${pendingLine}) after ${enters} Enters.`,
    );
  }
}
