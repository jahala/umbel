import { z } from 'zod';
import { RctrlUsageError } from '../core/errors.ts';
import { EnvValueSchema, ProviderNameSchema } from '../core/types.ts';

// ---------------------------------------------------------------------------
// parseDuration — e.g. '5m', '30s', '1h', '500ms' → milliseconds
// ---------------------------------------------------------------------------

export function parseDuration(text: string): number {
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (match === null) {
    throw new RctrlUsageError(`Invalid duration '${text}'. Use e.g. '5m', '30s', '1h', '500ms'.`);
  }
  const value = Number.parseFloat(match[1] ?? '0');
  const unit = match[2];
  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      throw new RctrlUsageError(`Unknown duration unit '${unit}'.`);
  }
}

// ---------------------------------------------------------------------------
// VerbSchemas — single source of truth for all verbs
// ---------------------------------------------------------------------------

export const VerbSchemas = {
  spawn: z.object({
    name: z.string().optional(),
    cwd: z.string().default('.'),
    provider: ProviderNameSchema.optional(),
    model: z.string().optional(),
    allowedTools: z.string().optional(),
    // Per-worker environment overrides, merged over the inherited environment.
    // Values may be literals or {fromEnv} references (resolved at spawn time).
    env: z.record(z.string(), EnvValueSchema).optional(),
  }),
  send: z.object({
    name: z.string(),
    prompt: z.string(),
  }),
  wait: z.object({
    name: z.string(),
    until: z.enum(['stop', 'file', 'pattern']).default('stop'),
    file: z.string().optional(),
    pattern: z.string().optional(),
    timeout: z.string().optional(),
    // Opt-in idle net: settle 'idle' if the pane shows no change for this long.
    idleTimeout: z.string().optional(),
    // Stop-mtime baseline from a prior rctrl_send call. Thread this from
    // rctrl_send's sinceMtime return value so send-in-one-process and
    // wait-in-another are race-free (without it the baseline defaults to 0,
    // which falsely resolves if the stop file pre-dates the send).
    sinceMtime: z.number().optional(),
  }),
  status: z.object({
    name: z.string().optional(),
  }),
  ls: z.object({}),
  kill: z.object({
    name: z.string(),
    keepState: z.boolean().default(false),
  }),
  attach: z.object({
    name: z.string(),
  }),
  read: z.object({
    name: z.string(),
    head: z.number().int().nonnegative().optional(),
    tail: z.number().int().nonnegative().optional(),
    section: z.string().optional(),
    full: z.boolean().optional(),
  }),
  capture: z.object({
    name: z.string(),
    lines: z.number().int().positive().default(100),
  }),
  logs: z.object({
    name: z.string(),
    follow: z.boolean().default(false),
  }),
  run: z.object({
    file: z.string(),
  }),
  mcp: z.object({}),
} as const;

export type VerbName = keyof typeof VerbSchemas;
export type VerbArgs<V extends VerbName> = z.infer<(typeof VerbSchemas)[V]>;
