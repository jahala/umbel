import { RctrlUsageError } from '../core/errors.ts';
import { generateSessionName, isValidSessionName } from '../core/id.ts';
import type { Session } from '../core/types.ts';
import { SessionSchema } from '../core/types.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// SpawnOpts / SpawnResult
// ---------------------------------------------------------------------------

export interface SpawnOpts {
  name?: string;
  cwd: string;
  model?: 'opus' | 'sonnet' | 'haiku';
  allowedTools?: string;
  anonymous?: boolean;
  claudeBin?: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

export interface SpawnResult {
  session: Session;
  jsonlPath: string;
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

export async function spawn(opts: SpawnOpts): Promise<SpawnResult> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};
  const claudeBin = opts.claudeBin ?? 'claude';

  const name = opts.name ?? generateSessionName('anon');

  if (!isValidSessionName(name)) {
    throw new RctrlUsageError(`Invalid session name: ${name}`);
  }

  const anonymous = opts.anonymous ?? opts.name === undefined;

  // Install global stop hook
  const { stopScriptPath } = await d.hooks.ensureGlobalHooks(env);

  // Create session directory
  await d.fs.ensureSessionDir(name, env);

  // Build settings JSON (inline, no collision with existing settings files)
  const settingsJson = d.hooks.buildSettingsJson(
    opts.allowedTools !== undefined
      ? { hookScriptPath: stopScriptPath, allowedTools: opts.allowedTools }
      : { hookScriptPath: stopScriptPath },
  );

  // Build claude command args
  const claudeArgs: string[] = [claudeBin, '--settings', settingsJson];
  if (opts.model !== undefined) {
    claudeArgs.push('--model', opts.model);
  }

  const sinceMs = Date.now();

  // Build env for tmux session — must include RCTRL_STATE and RCTRL_SESSION_ID
  // so the stop hook can locate the session dir. Filter out undefined values.
  const stateRoot = d.fs.stateDir(env);
  const tmuxEnv: Record<string, string> = {
    RCTRL_STATE: stateRoot,
    RCTRL_SESSION_ID: name,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && k !== 'RCTRL_STATE' && k !== 'RCTRL_SESSION_ID') {
      tmuxEnv[k] = v;
    }
  }

  try {
    await d.tmux.newSession({
      name,
      cwd: opts.cwd,
      cmd: claudeArgs,
      env: tmuxEnv,
    });
  } catch (err) {
    // Best-effort cleanup before re-throwing
    await d.tmux.killSession(name).catch(() => undefined);
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  let jsonlPath: string;
  try {
    jsonlPath = await d.jsonl.discoverSessionJsonl({
      sessionName: name,
      cwd: opts.cwd,
      sinceMs,
    });
  } catch (err) {
    await d.tmux.killSession(name).catch(() => undefined);
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  const session: Session = SessionSchema.parse({
    name,
    cwd: opts.cwd,
    model: opts.model,
    anonymous,
    createdAt: sinceMs,
    jsonlPath,
  });

  try {
    await d.fs.writeMeta(name, session, env);
  } catch (err) {
    await d.tmux.killSession(name).catch(() => undefined);
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  return { session, jsonlPath };
}
