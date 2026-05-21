import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as jsonlAdapter from '../../src/adapters/jsonl.ts';
import { killSession } from '../../src/adapters/tmux.ts';
import { SessionDeadError } from '../../src/core/errors.ts';
import { runWorkflow } from '../../src/faces/workflow.ts';

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
let jsonlDir = '';

async function setup(): Promise<Record<string, string | undefined>> {
  tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-wf-test-'));
  // All JSONL files go into a flat dir; we override discoverSessionJsonl to look by name
  jsonlDir = join(tmpDir, 'jsonl');
  await mkdir(jsonlDir, { recursive: true });
  return { RCTRL_STATE: tmpDir };
}

function sessionTag(suffix: string): string {
  return `t${RUN_ID}${suffix}`;
}

const CREATED: string[] = [];

afterEach(async () => {
  await Promise.all(CREATED.splice(0).map((n) => killSession(n).catch(() => undefined)));
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
    jsonlDir = '';
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A session-name-aware discoverSessionJsonl: since fake-claude writes
// ${FAKE_CLAUDE_JSONL_DIR}/${RCTRL_SESSION_ID}.jsonl, and RCTRL_SESSION_ID is
// the rctrl session name, we can look up the file directly by name.
async function sessionAwareDiscover(opts: {
  sessionName: string;
  cwd: string;
  sinceMs: number;
  projectsRoot?: string;
  timeoutMs?: number;
}): Promise<string> {
  const path = join(jsonlDir, `${opts.sessionName}.jsonl`);
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  let delay = 50;

  while (true) {
    try {
      await stat(path);
      return path;
    } catch {
      // not yet
    }
    if (Date.now() + delay > deadline) {
      throw new SessionDeadError(opts.sessionName, 'JSONL file did not appear within timeout');
    }
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
}

function makeWorkflowOpts(
  env: Record<string, string | undefined>,
  file: string,
): Parameters<typeof runWorkflow>[0] {
  return {
    file,
    claudeBin: join(import.meta.dir, '../fixtures/fake-claude.sh'),
    env: {
      ...env,
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      FAKE_CLAUDE_HOOK: join(tmpDir, 'hooks', 'stop.sh'),
    },
    deps: {
      jsonl: {
        ...jsonlAdapter,
        discoverSessionJsonl: sessionAwareDiscover,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflow', () => {
  test('two-step sequential workflow (needs) runs step1 then step2', async () => {
    const env = await setup();
    const step1 = sessionTag('s1');
    const step2 = sessionTag('s2');

    const yaml = `
workers:
  ${step1}: { cwd: "${tmpDir}" }
  ${step2}: { cwd: "${tmpDir}" }

steps:
  - run: ${step1}
    prompt: "step one prompt"
    outputs:
      result: assistant_last_message

  - run: ${step2}
    needs: [${step1}]
    prompt: "step two prompt using {{ steps.${step1}.outputs.result }}"
    outputs:
      result: assistant_last_message
`;

    const yamlFile = join(tmpDir, 'test.yaml');
    await writeFile(yamlFile, yaml, 'utf8');

    const result = await runWorkflow(makeWorkflowOpts(env, yamlFile));

    expect(result.status).toBe('completed');
    expect(result.outputs[step1]?.result).toContain('Response to: step one prompt');
    // step2's prompt includes the substituted step1 output
    expect(result.outputs[step2]?.result).toContain('Response to: step two prompt using');
  });

  test('assistant_last_message output substitution works', async () => {
    const env = await setup();
    const step1 = sessionTag('am1');
    const step2 = sessionTag('am2');

    const yaml = `
workers:
  ${step1}: { cwd: "${tmpDir}" }
  ${step2}: { cwd: "${tmpDir}" }

steps:
  - run: ${step1}
    prompt: "produce output"
    outputs:
      msg: assistant_last_message

  - run: ${step2}
    needs: [${step1}]
    prompt: "got: {{ steps.${step1}.outputs.msg }}"
`;

    const yamlFile = join(tmpDir, 'subst.yaml');
    await writeFile(yamlFile, yaml, 'utf8');

    const result = await runWorkflow(makeWorkflowOpts(env, yamlFile));

    expect(result.status).toBe('completed');
    expect(result.outputs[step1]?.msg).toContain('Response to: produce output');
  });

  test('step failure returns status=failed and remaining steps not run', async () => {
    const env = await setup();
    const step1 = sessionTag('f1');
    const step2 = sessionTag('f2');

    // Create a fake-claude that exits immediately with no JSONL file and no stop hook —
    // this causes discoverSessionJsonl to time out, which the workflow treats as failure.
    // We also shorten the JSONL discovery timeout via a dep override.
    const failingClaude = join(tmpDir, 'fail-claude.sh');
    await writeFile(failingClaude, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

    const yaml = `
workers:
  ${step1}: { cwd: "${tmpDir}" }
  ${step2}: { cwd: "${tmpDir}" }

steps:
  - run: ${step1}
    prompt: "will fail"

  - run: ${step2}
    needs: [${step1}]
    prompt: "should not run"
`;

    const yamlFile = join(tmpDir, 'fail.yaml');
    await writeFile(yamlFile, yaml, 'utf8');

    // Override discoverSessionJsonl to time out very quickly
    const failOpts = {
      ...makeWorkflowOpts(env, yamlFile),
      claudeBin: failingClaude,
      deps: {
        ...makeWorkflowOpts(env, yamlFile).deps,
        jsonl: {
          ...jsonlAdapter,
          discoverSessionJsonl: async (opts: Parameters<typeof sessionAwareDiscover>[0]) => {
            // Wait briefly then give up
            await Bun.sleep(200);
            const { SessionDeadError: SDE } = await import('../../src/core/errors.ts');
            throw new SDE(opts.sessionName, 'JSONL not found (failure test)');
          },
        },
      },
    };

    const result = await runWorkflow(failOpts);

    expect(result.status).toBe('failed');
    expect(result.failedStep).toBeDefined();
    expect(result.failedStep?.worker).toBe(step1);
    expect(result.outputs[step2]).toBeUndefined();
  });

  test('parallel: two independent steps run in the same wave concurrently', async () => {
    const env = await setup();
    const stepA = sessionTag('pa');
    const stepB = sessionTag('pb');

    const yaml = `
workers:
  ${stepA}: { cwd: "${tmpDir}" }
  ${stepB}: { cwd: "${tmpDir}" }

steps:
  - run: ${stepA}
    prompt: "parallel step A"
    outputs:
      result: assistant_last_message

  - run: ${stepB}
    prompt: "parallel step B"
    outputs:
      result: assistant_last_message
`;

    const yamlFile = join(tmpDir, 'parallel.yaml');
    await writeFile(yamlFile, yaml, 'utf8');

    const result = await runWorkflow(makeWorkflowOpts(env, yamlFile));

    expect(result.status).toBe('completed');
    // Both steps ran and produced outputs
    expect(result.outputs[stepA]?.result).toContain('Response to: parallel step A');
    expect(result.outputs[stepB]?.result).toContain('Response to: parallel step B');
  });
});
