import { z } from 'zod';

// ---------------------------------------------------------------------------
// Branded session name
// ---------------------------------------------------------------------------

export const SessionNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .brand<'SessionName'>();

export type SessionName = z.infer<typeof SessionNameSchema>;

// ---------------------------------------------------------------------------
// Provider name
// ---------------------------------------------------------------------------

// All four planned providers are listed here so type-checking protects
// against typos. Only 'claude' is wired in the registry today; 'codex',
// 'gemini', and 'opencode' are structural placeholders for subsequent milestones.
export const ProviderNameSchema = z.enum(['claude', 'codex', 'gemini', 'opencode']);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

// ---------------------------------------------------------------------------
// Session (persisted as meta.json)
// ---------------------------------------------------------------------------

export const SessionSchema = z.object({
  name: SessionNameSchema,
  cwd: z.string(),
  // model is provider-agnostic; each provider has its own model names, so we
  // cannot constrain to a Claude-only enum here.
  model: z.string().optional(),
  provider: ProviderNameSchema.default('claude'),
  providerFiles: z.array(z.string()).default([]),
  anonymous: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  jsonlPath: z.string().nullable(),
  // Effective custom Anthropic-compatible endpoint (ANTHROPIC_BASE_URL) the
  // worker was launched with, or null. Non-secret routing info surfaced by
  // status so callers can confirm routing without a printenv round-trip.
  baseUrl: z.string().nullable().default(null),
});

export type Session = z.infer<typeof SessionSchema>;

// ---------------------------------------------------------------------------
// Worker env value — literal or {fromEnv} reference
// ---------------------------------------------------------------------------

// A worker env value is either a literal string or a reference to a variable in
// the umbel server's own environment ({fromEnv}). References are resolved at
// spawn time (see core/env.ts), so a secret can be passed by reference and never
// appears in the caller's tool-call transcript.
export const EnvValueSchema = z.union([z.string(), z.object({ fromEnv: z.string() }).strict()]);
export type EnvValue = z.infer<typeof EnvValueSchema>;

// ---------------------------------------------------------------------------
// WaitCondition — discriminated union with recursive all/any
// ---------------------------------------------------------------------------

// WaitCondition is the manually-written type because the branded SessionName
// in the zod discriminated union makes z.infer<> awkward at the recursive boundary.
export type WaitCondition =
  | { kind: 'stop'; session: SessionName; sinceMtime: number }
  | { kind: 'file'; path: string }
  | { kind: 'pattern'; session: SessionName; regex: string }
  | { kind: 'timeout'; ms: number }
  | { kind: 'all'; conditions: WaitCondition[] }
  | { kind: 'any'; conditions: WaitCondition[] };

// The input side is unknown because z.lazy with branded types inside a
// discriminated union causes inference conflicts at the recursive boundary.
const WaitConditionBaseSchema: z.ZodType<WaitCondition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('stop'),
      session: SessionNameSchema,
      sinceMtime: z.number(),
    }),
    z.object({
      kind: z.literal('file'),
      path: z.string(),
    }),
    z.object({
      kind: z.literal('pattern'),
      session: SessionNameSchema,
      regex: z.string(),
    }),
    z.object({
      kind: z.literal('timeout'),
      ms: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('all'),
      conditions: z.array(z.lazy(() => WaitConditionBaseSchema)).min(1),
    }),
    z.object({
      kind: z.literal('any'),
      conditions: z.array(z.lazy(() => WaitConditionBaseSchema)).min(1),
    }),
  ]),
);

export const WaitConditionSchema = WaitConditionBaseSchema;

// ---------------------------------------------------------------------------
// Workflow types
// ---------------------------------------------------------------------------

export const WorkerSpecSchema = z.object({
  cwd: z.string(),
  // model is provider-agnostic free-form string; provider validates its own
  // model names at launch time.
  model: z.string().optional(),
  provider: ProviderNameSchema.optional(),
  allowedTools: z.string().optional(),
  permissionMode: z.string().optional(),
  // Per-worker environment overrides, merged over the inherited environment.
  // Values may be literals or {fromEnv} references (resolved at spawn time).
  env: z.record(z.string(), EnvValueSchema).optional(),
});

export type WorkerSpec = z.infer<typeof WorkerSpecSchema>;

export const OutputSpecSchema = z.union([
  z.string().startsWith('file:'),
  z.literal('assistant_last_message'),
]);

export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const WorkflowStepSchema = z.object({
  run: SessionNameSchema,
  prompt: z.string(),
  wait: z.lazy(() => WaitConditionSchema).optional(),
  outputs: z.record(z.string(), OutputSpecSchema).optional(),
  needs: z.array(SessionNameSchema).optional(),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowSpecSchema = z.object({
  workers: z.record(SessionNameSchema, WorkerSpecSchema),
  steps: z.array(WorkflowStepSchema).min(1),
});

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
