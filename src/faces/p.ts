import { SessionNotFoundError, WaitTimeoutError } from '../core/errors.ts';
import { generateSessionName } from '../core/id.ts';
import { getProvider } from '../core/providers/registry.ts';
import { SessionNameSchema } from '../core/types.ts';
import type { Deps } from '../operations/deps.ts';
import { defaultDeps } from '../operations/deps.ts';
import { kill } from '../operations/kill.ts';
import { resolveTranscriptContent } from '../operations/resolve-transcript.ts';
import { send } from '../operations/send.ts';
import { spawn } from '../operations/spawn.ts';
import { waitFor } from '../operations/wait.ts';

// ---------------------------------------------------------------------------
// PModeOpts / PModeResult
// ---------------------------------------------------------------------------

export interface PModeOpts {
  prompt: string;
  name?: string;
  resume?: string;
  cwd: string;
  provider?: string;
  model?: string;
  allowedTools?: string;
  workerEnv?: Record<string, string>;
  outputFormat: 'text' | 'json';
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  claudeBin?: string;
  signal?: AbortSignal;
  deps?: Partial<Deps>;
}

export interface PModeResult {
  text: string;
  jsonlPath: string;
  sessionName: string;
}

// ---------------------------------------------------------------------------
// runP
// ---------------------------------------------------------------------------

export async function runP(opts: PModeOpts): Promise<PModeResult> {
  const env = opts.env ?? {};
  const deps = opts.deps;
  const d = { ...defaultDeps, ...deps };
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;

  let sessionName: string;
  let anonymous = false;
  // sessionCwd is the cwd of the running claude process — used later to resolve
  // the transcript path when it isn't already cached in meta.
  let sessionCwd: string;
  // spawnSinceMs is the timestamp captured before tmux launched claude. Used
  // by the discoverSessionJsonl fallback when transcript-path isn't available.
  let spawnSinceMs: number;

  if (opts.resume !== undefined) {
    const session = await d.fs.readMeta(opts.resume, env);
    sessionName = session.name;
    sessionCwd = session.cwd;
    spawnSinceMs = session.createdAt;
    anonymous = false;
  } else if (opts.name !== undefined) {
    const name = opts.name;
    let existing: Awaited<ReturnType<typeof d.fs.readMeta>> | undefined;
    try {
      existing = await d.fs.readMeta(name, env);
    } catch (err) {
      if (!(err instanceof SessionNotFoundError)) throw err;
    }
    if (existing !== undefined) {
      sessionName = existing.name;
      sessionCwd = existing.cwd;
      spawnSinceMs = existing.createdAt;
    } else {
      const spawnOpts = {
        name,
        cwd: opts.cwd,
        anonymous: false as const,
        env,
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
        ...(opts.workerEnv !== undefined ? { workerEnv: opts.workerEnv } : {}),
        ...(opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
        ...(deps !== undefined ? { deps } : {}),
      };
      const result = await spawn(spawnOpts);
      sessionName = result.session.name;
      sessionCwd = result.session.cwd;
      spawnSinceMs = result.session.createdAt;
    }
    anonymous = false;
  } else {
    const anonName = generateSessionName('anon');
    const spawnOpts = {
      name: anonName,
      cwd: opts.cwd,
      anonymous: true as const,
      env,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.workerEnv !== undefined ? { workerEnv: opts.workerEnv } : {}),
      ...(opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
      ...(deps !== undefined ? { deps } : {}),
    };
    const result = await spawn(spawnOpts);
    sessionName = result.session.name;
    sessionCwd = result.session.cwd;
    spawnSinceMs = result.session.createdAt;
    anonymous = true;
  }

  const killOpts = {
    name: sessionName,
    env,
    ...(deps !== undefined ? { deps } : {}),
  };

  // Anonymous sessions are killed on any exit path; named sessions persist.
  try {
    const sendResult = await send({
      name: sessionName,
      prompt: opts.prompt,
      env,
      ...(deps !== undefined ? { deps } : {}),
    });
    const sinceMtime = sendResult.sinceMtime;

    const condition = {
      kind: 'stop' as const,
      session: SessionNameSchema.parse(sessionName),
      sinceMtime,
    };

    const waitResult = await waitFor({
      name: sessionName,
      condition,
      sinceMtime,
      defaultTimeoutMs: timeoutMs,
      env,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(deps !== undefined ? { deps } : {}),
    });

    if (waitResult.reason === 'aborted') {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (waitResult.reason === 'timeout') {
      throw new WaitTimeoutError(condition);
    }

    // Real claude doesn't write the transcript until first message arrives, so
    // jsonlPath isn't known at spawn time. After Stop, the hook payload's
    // transcript_path landed in events/transcript-path (see stop.sh).
    // For command-based providers (exportTranscript), there is no on-disk path.
    const sessionMeta = await d.fs.readMeta(sessionName, env);
    const provider = getProvider(sessionMeta.provider);
    const content = await resolveTranscriptContent({
      name: sessionName,
      cwd: sessionCwd,
      sinceMs: spawnSinceMs,
      provider,
      env,
      ...(deps !== undefined ? { deps } : {}),
    });
    const text = provider.parseTranscript(content);
    // resolveTranscriptContent (file branch) persists jsonlPath into meta on first
    // resolve — re-read to get the updated value. Command-based providers have no
    // on-disk path, so set '' in that case.
    const updatedMeta = await d.fs.readMeta(sessionName, env);
    const jsonlPath = provider.exportTranscript !== undefined ? '' : (updatedMeta.jsonlPath ?? '');

    if (anonymous) {
      await kill(killOpts).catch(() => undefined);
    }

    return { text, jsonlPath, sessionName };
  } catch (err) {
    if (anonymous) {
      await kill(killOpts).catch(() => undefined);
    }
    throw err;
  }
}
