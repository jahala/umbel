import * as jsonl from '../adapters/jsonl.ts';
import { SessionNotFoundError, WaitTimeoutError } from '../core/errors.ts';
import { generateSessionName } from '../core/id.ts';
import { SessionNameSchema } from '../core/types.ts';
import { defaultDeps } from '../operations/deps.ts';
import type { Deps } from '../operations/deps.ts';
import { kill } from '../operations/kill.ts';
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
  model?: 'opus' | 'sonnet' | 'haiku';
  allowedTools?: string;
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
  let jsonlPath: string;
  let anonymous = false;

  if (opts.resume !== undefined) {
    const session = await d.fs.readMeta(opts.resume, env);
    sessionName = session.name;
    jsonlPath = session.jsonlPath ?? '';
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
      jsonlPath = existing.jsonlPath ?? '';
    } else {
      const spawnOpts = {
        name,
        cwd: opts.cwd,
        anonymous: false as const,
        env,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
        ...(opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
        ...(deps !== undefined ? { deps } : {}),
      };
      const result = await spawn(spawnOpts);
      sessionName = result.session.name;
      jsonlPath = result.jsonlPath;
    }
    anonymous = false;
  } else {
    const anonName = generateSessionName('anon');
    const spawnOpts = {
      name: anonName,
      cwd: opts.cwd,
      anonymous: true as const,
      env,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
      ...(deps !== undefined ? { deps } : {}),
    };
    const result = await spawn(spawnOpts);
    sessionName = result.session.name;
    jsonlPath = result.jsonlPath;
    anonymous = true;
  }

  const killOpts = {
    name: sessionName,
    env,
    ...(deps !== undefined ? { deps } : {}),
  };

  // Anonymous sessions are killed on any exit path; named sessions persist.
  // See docs/audit-B.md §B3.
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

    const text = await jsonl.lastAssistantMessage({ jsonlPath });

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
