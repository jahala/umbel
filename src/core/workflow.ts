import { parse as parseYaml } from 'yaml';
import { UmbelUsageError, WorkflowCycleError } from './errors.ts';
import { type WorkflowSpec, WorkflowSpecSchema, type WorkflowStep } from './types.ts';

// ---------------------------------------------------------------------------
// parseWorkflow
// ---------------------------------------------------------------------------

export function parseWorkflow(yamlText: string): WorkflowSpec {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UmbelUsageError(`Invalid workflow YAML: ${msg}`);
  }
  const result = WorkflowSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new UmbelUsageError(`Invalid workflow: ${result.error.message}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// topoSort — Kahn's algorithm, emitting waves of parallel steps
// ---------------------------------------------------------------------------

export function topoSort(steps: WorkflowStep[]): WorkflowStep[][] {
  // Build a map from session name → step for O(1) lookup
  const byName = new Map<string, WorkflowStep>();
  for (const step of steps) {
    byName.set(step.run, step);
  }

  // Compute in-degree for each step
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // name → list of steps that depend on it

  for (const step of steps) {
    if (!inDegree.has(step.run)) inDegree.set(step.run, 0);
    if (!dependents.has(step.run)) dependents.set(step.run, []);

    for (const dep of step.needs ?? []) {
      inDegree.set(step.run, (inDegree.get(step.run) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(step.run);
      dependents.set(dep, list);
    }
  }

  const waves: WorkflowStep[][] = [];
  const remaining = new Set(steps.map((s) => s.run));

  while (remaining.size > 0) {
    // Collect all steps with in-degree 0
    const wave: WorkflowStep[] = [];
    for (const name of remaining) {
      if ((inDegree.get(name) ?? 0) === 0) {
        const step = byName.get(name);
        if (step !== undefined) wave.push(step);
      }
    }

    if (wave.length === 0) {
      // Everything remaining has a non-zero in-degree → cycle
      const cycleNodes = [...remaining];
      throw new WorkflowCycleError(cycleNodes);
    }

    waves.push(wave);

    // Decrement in-degrees for each dependent of this wave's steps
    for (const step of wave) {
      remaining.delete(step.run);
      for (const dep of dependents.get(step.run) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      }
    }
  }

  return waves;
}

// ---------------------------------------------------------------------------
// substitute — tiny {{var}} template engine
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

export function substitute(
  template: string,
  ctx: {
    env: Record<string, string | undefined>;
    steps: Record<string, { outputs: Record<string, string> }>;
    currentSession?: string;
  },
): string {
  return template.replace(TEMPLATE_RE, (match, raw: string) => {
    const expr = raw.trim();

    if (expr === '$session') {
      if (ctx.currentSession === undefined) {
        throw new UmbelUsageError(`Unresolved template: ${match} — no currentSession in context`);
      }
      return ctx.currentSession;
    }

    if (expr.startsWith('env.')) {
      const key = expr.slice('env.'.length);
      const value = ctx.env[key];
      if (value === undefined) {
        throw new UmbelUsageError(`Unresolved template: ${match} — env.${key} is not set`);
      }
      return value;
    }

    const stepsMatch = expr.match(/^steps\.([^.]+)\.outputs\.(.+)$/);
    if (stepsMatch !== null) {
      const [, stepName, outputKey] = stepsMatch;
      const step = ctx.steps[stepName ?? ''];
      if (step === undefined) {
        throw new UmbelUsageError(
          `Unresolved template: ${match} — step '${stepName}' not found in completed steps`,
        );
      }
      const value = step.outputs[outputKey ?? ''];
      if (value === undefined) {
        throw new UmbelUsageError(
          `Unresolved template: ${match} — output '${outputKey}' not found in step '${stepName}'`,
        );
      }
      return value;
    }

    throw new UmbelUsageError(
      `Malformed template: ${match} — unrecognised reference pattern '${expr}'`,
    );
  });
}
