import { z } from 'zod';
import { UmbelUsageError } from '../core/errors.ts';
import type { WaitCondition } from '../core/types.ts';
import { EnvValueSchema, ProviderNameSchema, SessionNameSchema } from '../core/types.ts';

// ---------------------------------------------------------------------------
// parseDuration — e.g. '5m', '30s', '1h', '500ms' → milliseconds
// ---------------------------------------------------------------------------

export function parseDuration(text: string): number {
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (match === null) {
    throw new UmbelUsageError(`Invalid duration '${text}'. Use e.g. '5m', '30s', '1h', '500ms'.`);
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
      throw new UmbelUsageError(`Unknown duration unit '${unit}'.`);
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
    permissionMode: z.string().optional(),
    // No human present: each provider suppresses its own prompts. Refused at
    // spawn for a provider that cannot, rather than wedging on a prompt later.
    unattended: z.boolean().optional(),
    // Per-worker environment overrides, merged over what the worker inherits.
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
    // Stop-mtime baseline from a prior umbel_send call. Thread this from
    // umbel_send's sinceMtime return value so send-in-one-process and
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
    purge: z.boolean().default(false),
  }),
  prune: z.object({
    // Grace period for a tombstone, e.g. '24h'. Omitted, every dead session
    // is swept.
    olderThan: z.string().optional(),
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

// ---------------------------------------------------------------------------
// waitRequest: the wait a caller asked for, from the fields a face takes
// ---------------------------------------------------------------------------

export interface WaitRequest {
  condition?: WaitCondition;
  defaultTimeoutMs?: number;
  idleTimeoutMs?: number;
  sinceMtime?: number;
}

// PURE. Every face turns its arguments into a wait here. umbel_wait took until,
// file, pattern and timeout in its schema and passed none of them on, so a wait
// asked for 120s ran to the 30-minute default (umbel#98).
export function waitRequest(args: VerbArgs<'wait'>): WaitRequest {
  const out: WaitRequest = {};
  if (args.until === 'file') {
    if (args.file === undefined) {
      throw new UmbelUsageError(
        'wait: until=file needs the file to watch: --file PATH on the CLI, file over MCP.',
      );
    }
    out.condition = { kind: 'file', path: args.file };
  } else if (args.until === 'pattern') {
    if (args.pattern === undefined) {
      throw new UmbelUsageError(
        'wait: until=pattern needs the pattern to match: --pattern REGEX on the CLI, pattern over MCP.',
      );
    }
    out.condition = {
      kind: 'pattern',
      session: SessionNameSchema.parse(args.name),
      regex: args.pattern,
    };
  }
  if (args.timeout !== undefined) out.defaultTimeoutMs = parseDuration(args.timeout);
  if (args.idleTimeout !== undefined) out.idleTimeoutMs = parseDuration(args.idleTimeout);
  if (args.sinceMtime !== undefined) out.sinceMtime = args.sinceMtime;
  return out;
}

export type VerbName = keyof typeof VerbSchemas;
export type VerbArgs<V extends VerbName> = z.infer<(typeof VerbSchemas)[V]>;
