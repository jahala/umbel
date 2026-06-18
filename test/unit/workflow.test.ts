import { describe, expect, test } from 'bun:test';
import { UmbelUsageError, WorkflowCycleError } from '../../src/core/errors.ts';
import { parseWorkflow, substitute, topoSort } from '../../src/core/workflow.ts';

// ---------------------------------------------------------------------------
// parseWorkflow
// ---------------------------------------------------------------------------

describe('parseWorkflow', () => {
  const validYaml = `
workers:
  reviewer:
    cwd: /tmp/review
    model: sonnet
steps:
  - run: reviewer
    prompt: Review the code
`;

  test('parses valid YAML workflow', () => {
    const spec = parseWorkflow(validYaml);
    // Access via Object.values since workers keys are branded SessionName
    expect(Object.values(spec.workers)[0]?.cwd).toBe('/tmp/review');
    expect(spec.steps[0]?.prompt).toBe('Review the code');
  });

  test('throws on malformed YAML (invalid syntax)', () => {
    const bad = 'workers: :\n  bad: yaml: : :\n';
    expect(() => parseWorkflow(bad)).toThrow();
  });

  test('throws when workers field is missing', () => {
    const noWorkers = 'steps:\n  - run: reviewer\n    prompt: hi\n';
    expect(() => parseWorkflow(noWorkers)).toThrow();
  });

  test('throws when steps field is missing', () => {
    const noSteps = 'workers:\n  reviewer:\n    cwd: /tmp\n';
    expect(() => parseWorkflow(noSteps)).toThrow();
  });

  test('throws when steps is empty array', () => {
    const emptySteps = 'workers:\n  reviewer:\n    cwd: /tmp\nsteps: []\n';
    expect(() => parseWorkflow(emptySteps)).toThrow();
  });

  test('parses multi-worker multi-step workflow', () => {
    const yaml = `
workers:
  reviewer:
    cwd: /tmp/review
  fixer:
    cwd: /tmp/fix
    model: opus
steps:
  - run: reviewer
    prompt: Review
  - run: fixer
    prompt: Fix
    needs: [reviewer]
`;
    const spec = parseWorkflow(yaml);
    expect(Object.keys(spec.workers)).toHaveLength(2);
    expect(spec.steps).toHaveLength(2);
    expect(spec.steps[1]?.needs).toEqual(['reviewer' as never]);
  });

  test('parses step with wait condition', () => {
    const yaml = `
workers:
  worker:
    cwd: /tmp
steps:
  - run: worker
    prompt: Go
    wait:
      kind: stop
      session: worker
      sinceMtime: 0
`;
    const spec = parseWorkflow(yaml);
    expect(spec.steps[0]?.wait?.kind).toBe('stop');
  });

  test('throws on step missing prompt', () => {
    const yaml = `
workers:
  worker:
    cwd: /tmp
steps:
  - run: worker
`;
    expect(() => parseWorkflow(yaml)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// topoSort
// ---------------------------------------------------------------------------

describe('topoSort', () => {
  test('returns single step in one wave', () => {
    const steps = [{ run: 'a' as never, prompt: 'do it', needs: undefined }];
    const waves = topoSort(steps);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(1);
  });

  test('returns two independent steps in the same wave', () => {
    const steps = [
      { run: 'a' as never, prompt: 'a' },
      { run: 'b' as never, prompt: 'b' },
    ];
    const waves = topoSort(steps);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });

  test('orders linear dependency correctly', () => {
    const steps = [
      { run: 'a' as never, prompt: 'a' },
      { run: 'b' as never, prompt: 'b', needs: ['a' as never] },
      { run: 'c' as never, prompt: 'c', needs: ['b' as never] },
    ];
    const waves = topoSort(steps);
    expect(waves).toHaveLength(3);
    expect(waves[0]?.[0]?.run as string).toBe('a');
    expect(waves[1]?.[0]?.run as string).toBe('b');
    expect(waves[2]?.[0]?.run as string).toBe('c');
  });

  test('produces parallel wave when two steps depend on same predecessor', () => {
    const steps = [
      { run: 'root' as never, prompt: 'root' },
      { run: 'child1' as never, prompt: 'c1', needs: ['root' as never] },
      { run: 'child2' as never, prompt: 'c2', needs: ['root' as never] },
    ];
    const waves = topoSort(steps);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(1);
    expect(waves[1]).toHaveLength(2);
  });

  test('throws WorkflowCycleError on direct cycle', () => {
    const steps = [
      { run: 'a' as never, prompt: 'a', needs: ['b' as never] },
      { run: 'b' as never, prompt: 'b', needs: ['a' as never] },
    ];
    expect(() => topoSort(steps)).toThrow(WorkflowCycleError);
  });

  test('throws WorkflowCycleError on self-dependency', () => {
    const steps = [{ run: 'a' as never, prompt: 'a', needs: ['a' as never] }];
    expect(() => topoSort(steps)).toThrow(WorkflowCycleError);
  });

  test('throws WorkflowCycleError on longer cycle (a→b→c→a)', () => {
    const steps = [
      { run: 'a' as never, prompt: 'a', needs: ['c' as never] },
      { run: 'b' as never, prompt: 'b', needs: ['a' as never] },
      { run: 'c' as never, prompt: 'c', needs: ['b' as never] },
    ];
    expect(() => topoSort(steps)).toThrow(WorkflowCycleError);
  });
});

// ---------------------------------------------------------------------------
// substitute
// ---------------------------------------------------------------------------

describe('substitute', () => {
  // exactOptionalPropertyTypes: omit currentSession rather than set undefined
  const emptyCtx = {
    env: {} as Record<string, string | undefined>,
    steps: {} as Record<string, { outputs: Record<string, string> }>,
  };

  test('returns template unchanged when no variables', () => {
    expect(substitute('hello world', emptyCtx)).toBe('hello world');
  });

  test('substitutes {{ env.X }}', () => {
    const result = substitute('PR is {{ env.PR }}', {
      ...emptyCtx,
      env: { PR: '42' },
    });
    expect(result).toBe('PR is 42');
  });

  test('substitutes {{ steps.NAME.outputs.X }}', () => {
    const result = substitute('Review: {{ steps.reviewer.outputs.summary }}', {
      ...emptyCtx,
      steps: { reviewer: { outputs: { summary: 'LGTM' } } },
    });
    expect(result).toBe('Review: LGTM');
  });

  test('substitutes {{ $session }}', () => {
    const result = substitute('Running {{ $session }}', {
      ...emptyCtx,
      currentSession: 'worker-a',
    });
    expect(result).toBe('Running worker-a');
  });

  test('substitutes multiple occurrences', () => {
    const result = substitute('{{ env.A }} and {{ env.A }}', {
      ...emptyCtx,
      env: { A: 'hello' },
    });
    expect(result).toBe('hello and hello');
  });

  test('throws UmbelUsageError on unresolved env variable', () => {
    expect(() => substitute('value is {{ env.MISSING }}', emptyCtx)).toThrow(UmbelUsageError);
  });

  test('throws UmbelUsageError on unresolved step output (step not found)', () => {
    expect(() => substitute('value is {{ steps.missing.outputs.x }}', emptyCtx)).toThrow(
      UmbelUsageError,
    );
  });

  // Lines 128-130: step EXISTS but output key not found — unique throw path
  test('throws UmbelUsageError when step exists but output key is missing', () => {
    const ctx = {
      ...emptyCtx,
      steps: { reviewer: { outputs: { summary: 'LGTM' } } },
    };
    let caught: unknown;
    try {
      substitute('value is {{ steps.reviewer.outputs.nonexistent }}', ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof UmbelUsageError).toBe(true);
    expect((caught as UmbelUsageError).message).toContain('nonexistent');
    expect((caught as UmbelUsageError).message).toContain('reviewer');
  });

  test('throws UmbelUsageError on unresolved $session', () => {
    expect(() => substitute('session: {{ $session }}', emptyCtx)).toThrow(UmbelUsageError);
  });

  test('throws UmbelUsageError on malformed reference (unrecognised prefix)', () => {
    expect(() => substitute('value is {{ unknown.x }}', emptyCtx)).toThrow(UmbelUsageError);
  });

  test('handles whitespace in template expressions', () => {
    const result = substitute('val: {{  env.X  }}', {
      ...emptyCtx,
      env: { X: 'trimmed' },
    });
    expect(result).toBe('val: trimmed');
  });
});
