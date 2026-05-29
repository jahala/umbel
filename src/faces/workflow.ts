import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSessionName } from '../core/id.ts';
import { getProvider } from '../core/providers/registry.ts';
import type { WorkflowSpec, WorkflowStep } from '../core/types.ts';
import { parseWorkflow, substitute, topoSort } from '../core/workflow.ts';
import type { Deps } from '../operations/deps.ts';
import { defaultDeps } from '../operations/deps.ts';
import { kill } from '../operations/kill.ts';
import { resolveJsonlPath } from '../operations/resolve-jsonl.ts';
import { send } from '../operations/send.ts';
import { spawn } from '../operations/spawn.ts';
import { waitFor } from '../operations/wait.ts';

// ---------------------------------------------------------------------------
// RunWorkflowOpts / WorkflowRunResult
// ---------------------------------------------------------------------------

export interface RunWorkflowOpts {
  file: string;
  env?: Record<string, string | undefined>;
  claudeBin?: string;
  signal?: AbortSignal;
  deps?: Partial<Deps>;
}

export interface WorkflowRunResult {
  runId: string;
  status: 'completed' | 'failed';
  failedStep?: { worker: string; reason: string };
  outputs: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// runWorkflow
// ---------------------------------------------------------------------------

export async function runWorkflow(opts: RunWorkflowOpts): Promise<WorkflowRunResult> {
  const env = opts.env ?? {};
  const deps = opts.deps;
  const d = { ...defaultDeps, ...deps };

  const yamlText = await readFile(opts.file, 'utf8');
  const spec = parseWorkflow(yamlText);
  const waves = topoSort(spec.steps);

  const runId = generateSessionName('wf');
  const stateRoot = d.fs.stateDir(env);
  const runDir = join(stateRoot, 'workflows', runId);
  await mkdir(join(runDir, 'outputs'), { recursive: true });
  await writeFile(join(runDir, 'workflow.yaml'), yamlText, 'utf8');

  const stepOutputs: Record<string, { outputs: Record<string, string> }> = {};
  const activeSessions: string[] = [];

  async function persistStatus(s: 'running' | 'completed' | 'failed'): Promise<void> {
    await writeFile(
      join(runDir, 'status.json'),
      JSON.stringify({ runId, status: s }, null, 2),
      'utf8',
    );
  }

  await persistStatus('running');

  const ctx: StepContext = { env, d, opts, activeSessions, stepOutputs, runDir };

  for (const wave of waves) {
    const results = await Promise.allSettled(wave.map((step) => executeStep(step, spec, ctx)));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const step = wave[i];
      if (result === undefined || step === undefined) continue;

      if (result.status === 'rejected') {
        await Promise.allSettled(
          activeSessions.map((n) =>
            kill({ name: n, env, ...(deps !== undefined ? { deps } : {}) }).catch(() => undefined),
          ),
        );
        await persistStatus('failed');

        return {
          runId,
          status: 'failed',
          failedStep: {
            worker: step.run,
            reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
          outputs: flattenOutputs(stepOutputs),
        };
      }
    }
  }

  await persistStatus('completed');
  return { runId, status: 'completed', outputs: flattenOutputs(stepOutputs) };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function flattenOutputs(
  stepOutputs: Record<string, { outputs: Record<string, string> }>,
): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(stepOutputs).map(([k, v]) => [k, v.outputs]));
}

interface StepContext {
  env: Record<string, string | undefined>;
  d: Deps;
  opts: RunWorkflowOpts;
  activeSessions: string[];
  stepOutputs: Record<string, { outputs: Record<string, string> }>;
  runDir: string;
}

async function executeStep(
  step: WorkflowStep,
  spec: WorkflowSpec,
  ctx: StepContext,
): Promise<void> {
  const { env, opts, activeSessions, stepOutputs, runDir } = ctx;
  const deps = opts.deps;
  const workerName = step.run;

  // Build substitution context from accumulated outputs + env
  const substEnv = Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const prompt = substitute(step.prompt, {
    env: substEnv,
    steps: stepOutputs,
    currentSession: workerName,
  });

  const workerSpec = spec.workers[workerName];
  const cwd = workerSpec?.cwd ?? '.';

  // Spawn a fresh session per step
  const sessionName = generateSessionName(workerName.slice(0, 8));
  activeSessions.push(sessionName);

  try {
    const spawnOpts = {
      name: sessionName,
      cwd,
      anonymous: true as const,
      env,
      ...(workerSpec?.provider !== undefined ? { provider: workerSpec.provider } : {}),
      ...(workerSpec?.model !== undefined ? { model: workerSpec.model } : {}),
      ...(workerSpec?.allowedTools !== undefined ? { allowedTools: workerSpec.allowedTools } : {}),
      ...(workerSpec?.env !== undefined ? { workerEnv: workerSpec.env } : {}),
      ...(opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
      ...(deps !== undefined ? { deps } : {}),
    };
    const spawnResult = await spawn(spawnOpts);

    const sendOpts = {
      name: sessionName,
      prompt,
      env,
      ...(deps !== undefined ? { deps } : {}),
    };
    const sendResult = await send(sendOpts);

    const waitOpts = {
      name: sessionName,
      sinceMtime: sendResult.sinceMtime,
      env,
      ...(step.wait !== undefined ? { condition: step.wait } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(deps !== undefined ? { deps } : {}),
    };
    const waitResult = await waitFor(waitOpts);

    if (waitResult.reason === 'aborted') {
      throw new Error(`Step '${workerName}' aborted`);
    }
    if (waitResult.reason === 'timeout') {
      throw new Error(`Step '${workerName}' timed out waiting for its wait condition`);
    }

    // Capture outputs. JSONL is resolved lazily — spawn-time discovery is no
    // longer reliable for real claude (the transcript only exists after the
    // first message). resolveJsonlPath checks the hook-payload path first,
    // then falls back to dir-snapshot discovery.
    const outputs: Record<string, string> = {};
    const d = { ...defaultDeps, ...deps };
    let resolvedJsonl: string | undefined;
    for (const [outputKey, outputSpec] of Object.entries(step.outputs ?? {})) {
      if (outputSpec === 'assistant_last_message') {
        if (resolvedJsonl === undefined) {
          resolvedJsonl = await resolveJsonlPath({
            name: sessionName,
            cwd: spawnResult.session.cwd,
            sinceMs: spawnResult.session.createdAt,
            env,
            ...(deps !== undefined ? { deps } : {}),
          });
        }
        const sessionMeta = await d.fs.readMeta(sessionName, env);
        const provider = getProvider(sessionMeta.provider);
        const content = await Bun.file(resolvedJsonl).text();
        outputs[outputKey] = provider.parseTranscript(content);
      } else if (outputSpec.startsWith('file:')) {
        const filePath = outputSpec.slice('file:'.length);
        const resolved = filePath.startsWith('/') ? filePath : join(cwd, filePath);
        outputs[outputKey] = await readFile(resolved, 'utf8');
      }
    }

    stepOutputs[workerName] = { outputs };

    const stepOutputDir = join(runDir, 'outputs', workerName);
    await mkdir(stepOutputDir, { recursive: true });
    for (const [key, value] of Object.entries(outputs)) {
      await writeFile(join(stepOutputDir, key), value, 'utf8');
    }
  } finally {
    const idx = activeSessions.indexOf(sessionName);
    if (idx !== -1) activeSessions.splice(idx, 1);
    const killOpts = {
      name: sessionName,
      env,
      ...(deps !== undefined ? { deps } : {}),
    };
    await kill(killOpts).catch(() => undefined);
  }
}
