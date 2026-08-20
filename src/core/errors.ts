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
