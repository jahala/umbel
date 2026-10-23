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

// The listing filter, shared by status with no name and ls. Off by default: a
// fleet listing is what a caller asks for, and tombstones are the archive.
const ListFilterShape = z.object({
  all: z.boolean().default(false),
  // Only sessions of this repository. Any path inside it resolves to the
  // repository's main worktree, so a linked worktree works as the argument
  // (umbel#65).
  repo: z.string().optional(),
});

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
    ...ListFilterShape.shape,
  }),
  ls: ListFilterShape,
  kill: z.object({
    // Names kill exactly those sessions. A selector picks live sessions
    // instead, and the two forms cannot be mixed.
    names: z.array(z.string().min(1)).default([]),
    // Live sessions whose name starts with this.
    prefix: z.string().min(1).optional(),
    // Live sessions of this repository (umbel#65 resolves the main worktree).
    repo: z.string().min(1).optional(),
    // Print the targets and kill nothing.
    dryRun: z.boolean().default(false),
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
  // actions and diff were MCP tools with schemas written in mcp.ts while the
  // CLI took the same fields. One schema per concept, so both faces share
  // these (umbel#66).
  actions: z.object({
    name: z.string(),
  }),
  diff: z.object({
    name: z.string(),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
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
// VerbHelp — what `umbel <verb> --help` prints
// ---------------------------------------------------------------------------
//
// Every flag row names either the schema field it reads (the flag is that
// field's kebab-case name) or an explicit flag the schema does not hold. A test
// compares these rows against the flags each CLI handler reads and against the
// schema shape, so a new schema field or parser flag cannot go undocumented.

export interface VerbFlagHelp {
  readonly field?: string;
  readonly flag?: string;
  readonly arg?: string;
  readonly description: string;
  // Other spellings the parser accepts for the same flag.
  readonly also?: readonly string[];
}

export interface VerbPositionalHelp {
  readonly token: string;
  // The schema field this positional fills, when it fills one.
  readonly field?: string;
  readonly description: string;
}

export interface VerbExitCodeHelp {
  readonly code: number;
  readonly meaning: string;
}

export interface VerbHelp {
  // The one-line description the global usage lists.
  readonly summary: string;
  readonly usage: string;
  readonly positionals: readonly VerbPositionalHelp[];
  readonly flags: readonly VerbFlagHelp[];
  // Only where they differ from the global table in `umbel --help`.
  readonly exitCodes?: readonly VerbExitCodeHelp[];
  // Schema fields the MCP tool takes and the CLI does not.
  readonly mcpOnlyFields?: readonly string[];
  readonly note?: string;
}

export const VERB_HELP: Record<VerbName, VerbHelp> = {
  spawn: {
    summary: 'Create a new session running a provider CLI',
    usage: 'umbel spawn [NAME] [flags...]',
    positionals: [
      { token: '[NAME]', description: 'Session name; also --name. Default: anon-XXXXXX.' },
    ],
    flags: [
      { field: 'name', arg: 'NAME', description: 'Session name; also the first positional.' },
      {
        field: 'cwd',
        arg: 'PATH',
        description: 'Working directory for the worker. Default: $PWD.',
      },
      {
        field: 'provider',
        arg: 'PROVIDER',
        description: 'CLI to launch: claude, codex, gemini, opencode or agy. Default: claude.',
      },
      {
        field: 'model',
        arg: 'MODEL',
        description: 'Provider model. opencode and agy check it against their own model list.',
      },
      {
        field: 'allowedTools',
        arg: 'TOOLS',
        description: 'Comma-separated tools the worker may use without a prompt. Claude only.',
        also: ['--allowedTools'],
      },
      {
        field: 'permissionMode',
        arg: 'MODE',
        description: 'Provider permission mode. An explicit mode wins over --unattended.',
        also: ['--permissionMode'],
      },
      {
        field: 'unattended',
        description: 'No human present: suppress every prompt the provider would raise.',
      },
      {
        field: 'env',
        arg: 'KEY[=VALUE]',
        description: 'Worker variable, repeatable. A bare KEY passes yours by name.',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'The worker started and is ready.' },
      {
        code: 1,
        meaning: 'The worker was not created, or the provider has no unattended mode.',
      },
      { code: 2, meaning: 'Usage error: bad flags, unknown provider, unsupported option.' },
      { code: 126, meaning: 'The CLI needs a person to sign in on this machine.' },
    ],
  },
  send: {
    summary: 'Send a prompt to a session',
    usage: 'umbel send [--json] <name> <prompt>',
    positionals: [
      { token: 'NAME', field: 'name', description: 'Session name.' },
      {
        token: 'PROMPT',
        field: 'prompt',
        description: 'Prompt text; can also be given as --prompt.',
      },
    ],
    flags: [
      {
        flag: '--json',
        description: 'Print {sinceMtime} for a race-free wait --since across processes.',
      },
      { field: 'prompt', arg: 'PROMPT', description: 'Prompt text; also the second positional.' },
    ],
    exitCodes: [
      { code: 0, meaning: 'The prompt landed and a turn started.' },
      {
        code: 1,
        meaning: 'The prompt was not submitted, no turn started, or the session died.',
      },
      { code: 2, meaning: 'Usage error: a missing name or prompt.' },
    ],
  },
  wait: {
    summary: 'Wait for a session to finish',
    usage: 'umbel wait [--json] <name> [--until stop|file|pattern] [flags...]',
    positionals: [{ token: 'NAME', description: 'Session name.' }],
    flags: [
      {
        flag: '--json',
        description: 'Print one JSON object instead of the human-readable report.',
      },
      { field: 'name', arg: 'NAME', description: 'Session name; also the first positional.' },
      {
        field: 'until',
        arg: 'stop|file|pattern',
        description: 'Condition to wait on. Default: stop.',
      },
      { field: 'file', arg: 'PATH', description: 'Path to wait for; required with --until file.' },
      {
        field: 'pattern',
        arg: 'REGEX',
        description: 'Regex matched on the pane; required with --until pattern.',
      },
      {
        field: 'timeout',
        arg: 'DURATION',
        description: 'Hard deadline, e.g. 5m, 30s, 1h. Default: 30m.',
      },
      {
        field: 'idleTimeout',
        arg: 'DURATION',
        description: 'Settle idle after this long with nothing moving. Off by default.',
      },
      {
        field: 'sinceMtime',
        flag: '--since',
        arg: 'MTIME',
        description: 'The sinceMtime umbel send --json printed.',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'The condition was met: stop, file or pattern.' },
      { code: 122, meaning: 'provider-error: the pane shows a provider error, then stillness.' },
      { code: 123, meaning: 'idle: nothing moved for --idle-timeout.' },
      { code: 124, meaning: 'timeout: the hard deadline was hit.' },
      { code: 125, meaning: 'dead: the worker exited before finishing its turn.' },
      { code: 126, meaning: 'input: the worker needs an answer, or a person to sign in.' },
      { code: 130, meaning: 'aborted.' },
    ],
  },
  status: {
    summary: 'Show session status (live sessions when no name is given)',
    usage: 'umbel status [name] [flags...]',
    positionals: [{ token: '[NAME]', description: 'One session; omit to list live sessions.' }],
    flags: [
      { flag: '--json', description: 'Print the entries as a JSON array.' },
      { field: 'name', arg: 'NAME', description: 'One session; also the first positional.' },
      { field: 'all', description: 'Include dead sessions (tombstones).' },
      { field: 'repo', arg: 'PATH', description: 'Only sessions of the repository at PATH.' },
    ],
  },
  ls: {
    summary: 'List live sessions (--all includes dead ones, --repo one repository)',
    usage: 'umbel ls [flags...]',
    positionals: [],
    flags: [
      { flag: '--json', description: 'Print the entries as a JSON array.' },
      { field: 'all', description: 'Include dead sessions (tombstones).' },
      { field: 'repo', arg: 'PATH', description: 'Only sessions of the repository at PATH.' },
    ],
  },
  kill: {
    summary: 'Kill sessions by name or by --prefix / --repo (--dry-run lists)',
    usage: 'umbel kill <name>... | --prefix PREFIX [--repo PATH] [flags...]',
    positionals: [
      {
        token: 'NAME...',
        field: 'names',
        description: 'Session names. Cannot be mixed with --prefix or --repo.',
      },
    ],
    flags: [
      {
        field: 'prefix',
        arg: 'PREFIX',
        description: 'Kill live sessions whose name starts with PREFIX.',
      },
      { field: 'repo', arg: 'PATH', description: 'Narrow the kill to one repository.' },
      { field: 'dryRun', flag: '--dry-run', description: 'List the targets and kill nothing.' },
      { field: 'purge', description: "Remove each session's directory too." },
    ],
    exitCodes: [
      { code: 0, meaning: 'Every session was killed or already dead.' },
      { code: 1, meaning: 'A name was not found, or a kill failed.' },
      {
        code: 2,
        meaning: 'Usage error: no names and no selector, or both forms mixed.',
      },
    ],
  },
  prune: {
    summary: "Remove dead sessions' directories and tmux remains",
    usage: 'umbel prune [--older-than DURATION]',
    positionals: [],
    flags: [
      {
        field: 'olderThan',
        arg: 'DURATION',
        description: 'Keep sessions that died more recently than this, e.g. 24h.',
      },
    ],
  },
  attach: {
    summary: 'Attach to a session',
    usage: 'umbel attach <name>',
    positionals: [{ token: 'NAME', description: 'Session name.' }],
    flags: [
      { field: 'name', arg: 'NAME', description: 'Session name; also the first positional.' },
    ],
  },
  read: {
    summary: 'Read the last assistant message',
    usage: 'umbel read [--json] <name>',
    positionals: [{ token: 'NAME', description: 'Session name.' }],
    flags: [
      { flag: '--json', description: 'Print {text, usage} instead of the bare text.' },
      { field: 'name', arg: 'NAME', description: 'Session name; also the first positional.' },
    ],
    mcpOnlyFields: ['head', 'tail', 'section', 'full'],
    note: 'The MCP tool umbel_read also takes head, tail, section and full to window a long answer.',
  },
  actions: {
    summary: 'Digest of what a worker did (tools, files, errors)',
    usage: 'umbel actions [--json] <name>',
    positionals: [{ token: 'NAME', description: 'Session name.' }],
    flags: [
      { flag: '--json', description: 'Print the raw ActionManifest as one JSON object.' },
      { field: 'name', arg: 'NAME', description: 'Session name; also the first positional.' },
    ],
  },
  diff: {
    summary: 'Text diff between two turns of a session',
    usage: 'umbel diff <name> [--from N] [--to N]',
    positionals: [{ token: 'NAME', description: 'Session name.' }],
    flags: [
      { field: 'name', arg: 'NAME', description: 'Session name; also the first positional.' },
      {
        field: 'from',
        arg: 'N',
        description: 'Base turn index; negative counts from the end. Default: the previous turn.',
      },
      {
        field: 'to',
        arg: 'N',
        description: 'Target turn index; negative counts from the end. Default: the latest.',
      },
    ],
  },
  capture: {
    summary: 'Capture the last N tmux pane lines',
    usage: 'umbel capture <name> [--lines N]',
    positionals: [{ token: 'NAME', description: 'Session name.' }],
    flags: [
      { field: 'name', arg: 'NAME', description: 'Session name; also the first positional.' },
      { field: 'lines', arg: 'N', description: 'Number of pane lines. Default: 100.' },
    ],
    note: 'For watching a worker. Read its answer with umbel read, never by parsing the pane.',
  },
  logs: {
    summary: "Tail a session's event log",
    usage: 'umbel logs <name> [--follow]',
    positionals: [{ token: 'NAME', description: 'Session name.' }],
    flags: [
      { field: 'name', arg: 'NAME', description: 'Session name; also the first positional.' },
      {
        field: 'follow',
        description: 'Keep printing new entries. Stop with Ctrl-C.',
        also: ['-f'],
      },
    ],
  },
  run: {
    summary: 'Run a workflow YAML file',
    usage: 'umbel run <file>',
    positionals: [{ token: 'FILE', field: 'file', description: 'Workflow YAML file.' }],
    flags: [],
  },
  mcp: {
    summary: 'Start the MCP server',
    usage: 'umbel mcp',
    positionals: [],
    flags: [],
    note: 'Speaks MCP on stdio. A host launches it; it is not for interactive use.',
  },
};

const flagSpelling = (row: VerbFlagHelp): string =>
  row.flag ?? `--${(row.field ?? '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

function columnRows(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([head]) => head.length));
  return rows.map(([head, text]) => `  ${head.padEnd(width)}  ${text}`).join('\n');
}

// The Verbs block of the global usage, from the same table as the per-verb
// pages, so every listed verb has a page.
export function verbListLines(): string {
  return (Object.entries(VERB_HELP) as Array<[VerbName, VerbHelp]>)
    .map(([verb, help]) => `  ${verb.padEnd(9)}${help.summary}`)
    .join('\n');
}

// PURE. The whole page for one verb, or undefined when the verb is unknown.
export function verbHelpText(verb: string): string | undefined {
  const help = Object.hasOwn(VERB_HELP, verb) ? VERB_HELP[verb as VerbName] : undefined;
  if (help === undefined) return undefined;

  const sections: string[] = [`umbel ${verb}: ${help.summary}`, '', 'Usage:', `  ${help.usage}`];
  if (help.positionals.length > 0) {
    sections.push(
      '',
      'Positionals:',
      columnRows(help.positionals.map((row) => [row.token, row.description])),
    );
  }
  if (help.flags.length > 0) {
    sections.push(
      '',
      'Flags:',
      columnRows(
        help.flags.map((row) => [
          row.arg !== undefined ? `${flagSpelling(row)} ${row.arg}` : flagSpelling(row),
          row.also !== undefined && row.also.length > 0
            ? `${row.description} Also ${row.also.join(', ')}.`
            : row.description,
        ]),
      ),
    );
  }
  if (help.exitCodes !== undefined) {
    sections.push(
      '',
      'Exit codes:',
      columnRows(help.exitCodes.map((row) => [String(row.code), row.meaning])),
    );
  }
  if (help.note !== undefined) sections.push('', help.note);
  sections.push('', 'Run `umbel --help` for the other verbs and the exit codes not listed here.');
  return `${sections.join('\n')}\n`;
}

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
// ---------------------------------------------------------------------------
// killRequest: who to kill, from the fields a face takes
// ---------------------------------------------------------------------------

// PURE. The fields a face takes, as the request killMany checks: a mixed or
// empty call is refused there, once, for every face (umbel#94).
export interface KillRequest {
  names: string[];
  prefix?: string;
  repo?: string;
  dryRun: boolean;
  purge: boolean;
}

export function killRequest(args: VerbArgs<'kill'>): KillRequest {
  return {
    names: args.names,
    ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
    ...(args.repo !== undefined ? { repo: args.repo } : {}),
    dryRun: args.dryRun,
    purge: args.purge,
  };
}
export type VerbName = keyof typeof VerbSchemas;
export type VerbArgs<V extends VerbName> = z.infer<(typeof VerbSchemas)[V]>;
