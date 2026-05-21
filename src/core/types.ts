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
// Session (persisted as meta.json)
// ---------------------------------------------------------------------------

export const SessionSchema = z.object({
  name: SessionNameSchema,
  cwd: z.string(),
  model: z.enum(['opus', 'sonnet', 'haiku']).optional(),
  anonymous: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  jsonlPath: z.string().nullable(),
});

export type Session = z.infer<typeof SessionSchema>;

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
  model: z.enum(['opus', 'sonnet', 'haiku']).optional(),
  allowedTools: z.string().optional(),
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
