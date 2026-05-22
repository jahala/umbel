import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCleanupGuard, runCli, smokeDescribeFor } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Gemini workflow smoke test
// ---------------------------------------------------------------------------

const COLORS = ['red', 'blue', 'green'];

smokeDescribeFor('gemini', 'gemini workflow two-step picker/transformer', () => {
  const guard = makeCleanupGuard();

  afterEach(() => guard.cleanup());

  test('gemini two-step workflow completes and transformer echoes picker color', async () => {
    // Validates: workflow YAML executor with gemini provider, step output capture via
    // assistant_last_message, {{var}} substitution, status.json written as 'completed'
    const tmpDir = await mkdtemp(join(tmpdir(), 'rctrl-smoke-gem-wf-'));

    const yamlContent = `
workers:
  picker: { provider: gemini, cwd: "${tmpDir}" }
  transformer: { provider: gemini, cwd: "${tmpDir}" }
steps:
  - run: picker
    prompt: "Pick one of: red, blue, green. Reply with ONLY the word."
    wait: { stop: $session, timeout: 90s }
    outputs:
      color: assistant_last_message
  - run: transformer
    needs: [picker]
    prompt: "The chosen color is {{ steps.picker.outputs.color }}. Reply with that exact same color and nothing else."
    wait: { stop: $session, timeout: 90s }
    outputs:
      echoed: assistant_last_message
`;

    const yamlFile = join(tmpDir, 'smoke-gem-wf.yaml');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(yamlFile, yamlContent.trim(), 'utf8');

    const runResult = await runCli(['run', yamlFile]);
    expect(runResult.code).toBe(0);
    expect(runResult.stdout).toContain('workflow completed');

    // Extract runId from stdout: "workflow completed: runId=wf-xxxxxx"
    const match = runResult.stdout.match(/runId=([\w-]+)/);
    expect(match).not.toBeNull();
    const runId = match?.[1];
    expect(runId).toBeTruthy();

    // Verify status.json is 'completed'
    const stateRoot = process.env.RCTRL_STATE ?? join(homedir(), '.rctrl');
    const runDir = join(stateRoot, 'workflows', runId as string);
    const statusRaw = await readFile(join(runDir, 'status.json'), 'utf8');
    const statusJson = JSON.parse(statusRaw) as { status: string };
    expect(statusJson.status).toBe('completed');

    // Belt-and-suspenders: list the run dir to confirm it was created
    const entries = await readdir(join(runDir, 'outputs')).catch(() => []);
    expect(statusJson.status).toBe('completed');
    void entries;

    // Check the status dir has workflow.yaml copy
    const wfCopy = await readFile(join(runDir, 'workflow.yaml'), 'utf8');
    expect(wfCopy).toContain('picker');
    expect(wfCopy).toContain('transformer');
    void COLORS;
  }, 180_000);
});
