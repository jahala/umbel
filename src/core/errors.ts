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

export class RctrlUsageError extends Error {
  override name = 'RctrlUsageError';
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
