import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  AllowedToolsUnsupportedError,
  EnvRefUnresolvedError,
  HookTimeoutError,
  ModelListUnavailableError,
  ModelUnknownError,
  OpencodeConfigUnparsableError,
  ProviderNotSignedInError,
  ProviderUnknownError,
  SendNotSubmittedError,
  SendTurnNotStartedError,
  SessionDeadError,
  SessionNotCreatedError,
  SessionNotFoundError,
  TmuxError,
  UmbelUsageError,
  UnattendedUnsupportedError,
  WaitTimeoutError,
  WorkerBlockedError,
} from '../core/errors.ts';
import { isValidSessionName } from '../core/id.ts';
import type { RunningCommand } from '../core/procs.ts';
import { getProvider } from '../core/providers/registry.ts';
import type { Usage } from '../core/providers/types.ts';
import { SPAWN_EXIT_CODES } from '../core/spawn-refusals.ts';
import type { EnvValue } from '../core/types.ts';
import { WAIT_EXIT_CODES } from '../core/wait-reasons.ts';
import { actions, actionsManifest } from '../operations/actions.ts';
import { capture } from '../operations/capture.ts';
import { defaultDeps } from '../operations/deps.ts';
import { diff } from '../operations/diff.ts';
import { type KillResult, killMany } from '../operations/kill.ts';
import { prune } from '../operations/prune.ts';
import { resolveTranscriptContent } from '../operations/resolve-transcript.ts';
import { send } from '../operations/send.ts';
import { spawn } from '../operations/spawn.ts';
import { status } from '../operations/status.ts';
import { waitFor } from '../operations/wait.ts';
import { runMcpServer } from './mcp.ts';
import { runP } from './p.ts';
import {
  type KillRequest,
  killRequest,
  parseDuration,
  verbHelpText,
  verbListLines,
  waitRequest,
} from './verbs.ts';
import { runWorkflow } from './workflow.ts';

const VERSION = '0.0.1';

const HELP = `umbel — remote-control an interactive agent CLI over tmux
           (claude, codex, gemini, opencode, agy)

Usage:
  umbel <verb> [flags...]    Supervisor verbs
  umbel <verb> --help        That verb's flags and exit codes
  umbel -p [PROMPT]          Drop-in for claude -p
  umbel --help               Show this global usage
  umbel --version            Show version

Verbs:
${verbListLines()}

Exit codes:
  0    Success
  1    Generic error (session dead, tmux failure, hook timeout,
       session not created, provider has no unattended mode)
  2    Usage error (bad flags, missing required argument, unknown verb, unsupported option)
  122  wait provider-error — a provider error on the pane, then stillness
  123  wait idle — pane, events and transcript still for --idle-timeout
  124  wait timeout — hard deadline hit
  125  wait dead — worker exited before finishing its turn
  126  wait input — worker is blocked waiting for input (permission / prompt /
       usage limit); spawn refused: the CLI needs a person to sign in first
  130  Aborted (SIGINT)
`;

interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
  // String-valued flags captured per-occurrence so repeatable flags (e.g.
  // --env KEY=VAL) collect every value, not just the last. `flags` stays
  // last-wins for everything else.
  repeated: Map<string, string[]>;
}

// Flags that never take a value. Without this the `--flag value` form would
// greedily consume the following positional (e.g. `send --json <name>` eating
// the session name as --json's value).
const BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'version',
  'json',
  'follow',
  'purge',
  'dry-run',
  'unattended',
  'all',
]);

function parseArgv(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const repeated = new Map<string, string[]>();
  const positionals: string[] = [];
  const addRepeated = (key: string, value: string): void => {
    const arr = repeated.get(key);
    if (arr === undefined) repeated.set(key, [value]);
    else arr.push(value);
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      for (let j = i + 1; j < argv.length; j++) {
        positionals.push(argv[j] ?? '');
      }
      break;
    }
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        flags.set(key, value);
        addRepeated(key, value);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('-')) {
          flags.set(key, next);
          addRepeated(key, next);
          i++;
        } else {
          flags.set(key, true);
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flags are ALWAYS boolean. The naive "consume the next arg if it
      // doesn't start with -" rule eats the positional prompt in `-p "..."`,
      // which mirrors `claude -p "prompt"`'s contract. If a future flag needs
      // a value, use the long form: --foo value.
      flags.set(arg.slice(1), true);
    } else {
      positionals.push(arg);
    }
    i++;
  }
  return { flags, positionals, repeated };
}

function flagStr(flags: Map<string, string | boolean>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = flags.get(key);
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function flagBool(flags: Map<string, string | boolean>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (flags.has(key) && flags.get(key) !== false) return true;
  }
  return false;
}

// The listing filter ls and status with no name share, so the two answer the
// same way to the same flags.
function listFilter(flags: Map<string, string | boolean>): { all: boolean; repo?: string } {
  const repo = flagStr(flags, 'repo');
  // A bare --repo would otherwise list every repository, which looks like a
  // filter that found nothing.
  if (repo === undefined && flags.has('repo')) {
    throw new UmbelUsageError('--repo needs a path: --repo PATH');
  }
  return {
    all: flagBool(flags, 'all'),
    ...(repo !== undefined ? { repo } : {}),
  };
}

// Parse repeated --env flags into an override map. `KEY=VALUE` sets a literal;
// a bare `KEY` passes KEY through from umbel's own environment as a {fromEnv}
// reference, so a secret never has to sit on the spawn's argv (umbel#93). An
// empty key throws, and an unset KEY fails where the reference is resolved, so
// nothing is dropped silently.
export function parseEnvFlags(entries: string[]): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq === 0 || entry === '') {
      throw new UmbelUsageError(`Invalid --env '${entry}'. Use --env KEY=VALUE or --env KEY.`);
    }
    if (eq < 0) out[entry] = { fromEnv: entry };
    else out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function truncateCwd(cwd: string, max = 30): string {
  if (cwd.length <= max) return cwd;
  return `…${cwd.slice(-(max - 1))}`;
}

type StatusEntry = Awaited<ReturnType<typeof status>>[0];

// One line for the table: the branch, then what the worker has done since
// spawn. The HEAD and every count are in --json; a row is read at a glance and
// the full detail would crowd out the columns beside it.
function workspaceSummary(w: StatusEntry['workspace']): string {
  if (w === null) return '—';
  // --json carries the full object id; a row shows the seven characters git
  // itself prints for a detached HEAD.
  const parts = [w.branch ?? (w.head === null ? 'no branch' : `detached@${w.head.slice(0, 7)}`)];
  if (w.commits.length > 0) {
    parts.push(`${w.commits.length} ${w.commits.length === 1 ? 'commit' : 'commits'}`);
  }
  if (w.changedFiles > 0) parts.push(`${w.changedFiles} changed`);
  if (w.untrackedFiles > 0) parts.push(`${w.untrackedFiles} untracked`);
  const { insertions, deletions } = w.diffStat;
  if (insertions > 0 || deletions > 0) parts.push(`+${insertions}/-${deletions}`);
  return parts.join(' ');
}

// A dead worker's STATUS names what it died of, when tmux recorded a status, so
// the post-mortem starts at the table. A death by signal recorded none; the
// pane snapshot in events/dead names it.
function statusWord(e: StatusEntry): string {
  if (e.alive) return 'alive';
  const exitCode = e.dead?.exitCode;
  return exitCode === undefined ? 'dead' : `dead (exit ${exitCode})`;
}

function printStatusTable(entries: StatusEntry[]): void {
  const rows = entries.map((e) => ({
    name: e.name,
    status: statusWord(e),
    running: String(e.runningCommands.length),
    // The folder name, not the path: a row is read at a glance and the full
    // path of every session would crowd out the columns that matter. A session
    // spawned before umbel recorded its repository has none.
    repo: e.repo === null ? '—' : basename(e.repo),
    workspace: workspaceSummary(e.workspace),
    model: e.model ?? '—',
    cwd: truncateCwd(e.cwd),
    created: formatTimestamp(e.createdAt),
    last: e.lastActivityAt !== undefined ? formatTimestamp(e.lastActivityAt) : '—',
  }));

  type RowKey = keyof (typeof rows)[0];
  const cols: Array<{ key: RowKey; header: string }> = [
    { key: 'name', header: 'NAME' },
    { key: 'status', header: 'STATUS' },
    { key: 'running', header: 'RUNNING' },
    { key: 'repo', header: 'REPO' },
    { key: 'workspace', header: 'WORKSPACE' },
    { key: 'model', header: 'MODEL' },
    { key: 'cwd', header: 'CWD' },
    { key: 'created', header: 'CREATED' },
    { key: 'last', header: 'LAST' },
  ];

  const widths = cols.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(r[c.key]).length)),
  );

  process.stdout.write(`${cols.map((c, i) => c.header.padEnd(widths[i] ?? 0)).join('  ')}\n`);
  for (const row of rows) {
    process.stdout.write(
      `${cols.map((c, i) => String(row[c.key]).padEnd(widths[i] ?? 0)).join('  ')}\n`,
    );
  }
}

function errorExitCode(err: unknown): number {
  if (err instanceof WaitTimeoutError) return 124;
  if (err instanceof WorkerBlockedError) return 126;
  if (
    err instanceof UmbelUsageError ||
    err instanceof ProviderUnknownError ||
    err instanceof EnvRefUnresolvedError ||
    err instanceof AllowedToolsUnsupportedError ||
    err instanceof ModelUnknownError
  ) {
    return 2;
  }
  if (err instanceof ProviderNotSignedInError) return SPAWN_EXIT_CODES['not-signed-in'];
  if (
    err instanceof SessionDeadError ||
    err instanceof SendNotSubmittedError ||
    err instanceof SendTurnNotStartedError ||
    err instanceof TmuxError ||
    err instanceof HookTimeoutError ||
    err instanceof SessionNotFoundError ||
    err instanceof SessionNotCreatedError ||
    err instanceof UnattendedUnsupportedError ||
    err instanceof OpencodeConfigUnparsableError ||
    err instanceof ModelListUnavailableError
  ) {
    return 1;
  }
  if (err instanceof Error && err.name === 'AbortError') return 130;
  return 1;
}

function printError(err: unknown): void {
  process.stderr.write(`umbel: ${err instanceof Error ? err.message : String(err)}\n`);
}

// Forward env vars the user may set in their shell that affect umbel's
// behaviour. We deliberately whitelist instead of passing process.env wholesale
// (see src/operations/spawn.ts for why).
function getCliEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (process.env.UMBEL_STATE !== undefined) out.UMBEL_STATE = process.env.UMBEL_STATE;
  return out;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const { flags, positionals, repeated } = parseArgv(argv);

  if (flagBool(flags, 'help', 'h')) {
    // `umbel <verb> --help` answers for that verb; anything else falls back to
    // the global page, including an unknown verb.
    const requested = positionals[0];
    const perVerb = requested !== undefined ? verbHelpText(requested) : undefined;
    process.stdout.write(perVerb ?? HELP);
    return 0;
  }

  if (flagBool(flags, 'version')) {
    process.stdout.write(`umbel ${VERSION}\n`);
    return 0;
  }

  if (flagBool(flags, 'p', 'print')) {
    return runPMode(flags, positionals, repeated);
  }

  if (positionals.length === 0) {
    process.stdout.write(HELP);
    return 2;
  }

  const verb = positionals[0] ?? '';
  const rest = positionals.slice(1);

  try {
    switch (verb) {
      case 'spawn':
        return await verbSpawn(flags, rest, repeated);
      case 'send':
        return await verbSend(flags, rest);
      case 'wait':
        return await verbWait(flags, rest);
      case 'status':
        return await verbStatus(flags, rest);
      case 'ls':
        return await verbLs(flags);
      case 'kill':
        return await verbKill(flags, rest);
      case 'prune':
        return await verbPrune(flags);
      case 'attach':
        return await verbAttach(flags, rest);
      case 'read':
        return await verbRead(flags, rest);
      case 'actions':
        return await verbActions(flags, rest);
      case 'diff':
        return await verbDiff(flags, rest);
      case 'capture':
        return await verbCapture(flags, rest);
      case 'logs':
        return await verbLogs(flags, rest);
      case 'run':
        return await verbRun(rest);
      case 'mcp':
        return await verbMcp();
      default:
        process.stderr.write(`umbel: unknown verb '${verb}'\n`);
        process.stderr.write(HELP);
        return 2;
    }
  } catch (err) {
    printError(err);
    return errorExitCode(err);
  }
}

// ---------------------------------------------------------------------------
// -p mode
// ---------------------------------------------------------------------------

async function runPMode(
  flags: Map<string, string | boolean>,
  positionals: string[],
  repeated: Map<string, string[]>,
): Promise<number> {
  let prompt: string | undefined = positionals[0];

  if (prompt === undefined) {
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      prompt = Buffer.concat(chunks).toString('utf8');
    } else {
      process.stderr.write('umbel: no prompt provided\n');
      return 2;
    }
  }

  const rawFormat = flagStr(flags, 'output-format') ?? 'text';
  const outputFormat = rawFormat === 'json' ? ('json' as const) : ('text' as const);
  const rawTimeout = flagStr(flags, 'timeout');
  const provider = flagStr(flags, 'provider');
  const model = flagStr(flags, 'model');
  const name = flagStr(flags, 'name');
  const resume = flagStr(flags, 'resume');
  const allowedTools = flagStr(flags, 'allowed-tools', 'allowedTools');
  const permissionMode = flagStr(flags, 'permission-mode', 'permissionMode');
  const timeoutMs = rawTimeout !== undefined ? parseDuration(rawTimeout) : undefined;
  // UMBEL_CLAUDE_BIN overrides the binary of whichever provider runs. The name
  // is historical; tests inject a fake claude, codex, gemini, opencode or agy.
  const claudeBin = process.env.UMBEL_CLAUDE_BIN;

  try {
    const envEntries = repeated.get('env') ?? [];
    const workerEnv = envEntries.length > 0 ? parseEnvFlags(envEntries) : undefined;
    const pOpts = {
      prompt,
      cwd: flagStr(flags, 'cwd') ?? process.cwd(),
      outputFormat,
      env: getCliEnv(),
      ...(name !== undefined ? { name } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(workerEnv !== undefined ? { workerEnv } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(claudeBin !== undefined ? { claudeBin } : {}),
    };
    const result = await runP(pOpts);

    if (outputFormat === 'json') {
      process.stdout.write(
        `${JSON.stringify({ text: result.text, sessionName: result.sessionName })}\n`,
      );
    } else {
      process.stdout.write(`${result.text}\n`);
    }
    return 0;
  } catch (err) {
    printError(err);
    return errorExitCode(err);
  }
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

async function verbSpawn(
  flags: Map<string, string | boolean>,
  positionals: string[],
  repeated: Map<string, string[]>,
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name !== undefined && !isValidSessionName(name)) {
    throw new UmbelUsageError(`Invalid session name: ${name}`);
  }
  const cwd = flagStr(flags, 'cwd') ?? process.cwd();
  const provider = flagStr(flags, 'provider');
  const model = flagStr(flags, 'model');
  const allowedTools = flagStr(flags, 'allowed-tools', 'allowedTools');
  const permissionMode = flagStr(flags, 'permission-mode', 'permissionMode');
  const unattended = flagBool(flags, 'unattended');
  // UMBEL_CLAUDE_BIN overrides the binary of whichever provider runs. The name
  // is historical; tests inject a fake claude, codex, gemini, opencode or agy.
  const claudeBin = process.env.UMBEL_CLAUDE_BIN;
  const envEntries = repeated.get('env') ?? [];
  const workerEnv = envEntries.length > 0 ? parseEnvFlags(envEntries) : undefined;

  const spawnOpts = {
    cwd,
    env: getCliEnv(),
    ...(name !== undefined ? { name } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(unattended ? { unattended } : {}),
    ...(workerEnv !== undefined ? { workerEnv } : {}),
    ...(claudeBin !== undefined ? { claudeBin } : {}),
  };
  const result = await spawn(spawnOpts);
  process.stdout.write(`spawned: ${result.session.name}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

async function verbSend(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = positionals[0];
  const prompt = flagStr(flags, 'prompt') ?? positionals[1];
  if (name === undefined) throw new UmbelUsageError('send: <name> is required');
  if (prompt === undefined) throw new UmbelUsageError('send: <prompt> is required');
  const result = await send({ name, prompt, env: getCliEnv() });
  if (flagBool(flags, 'json')) {
    process.stdout.write(`${JSON.stringify({ sinceMtime: result.sinceMtime })}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

async function verbWait(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name === undefined) throw new UmbelUsageError('wait: <name> is required');

  const jsonMode = flagBool(flags, 'json');
  const until = (flagStr(flags, 'until') ?? 'stop') as 'stop' | 'file' | 'pattern';
  const rawTimeout = flagStr(flags, 'timeout');

  // --since provides the stop-mtime baseline captured before send, making
  // send-in-one-process and wait-in-another race-free.
  const rawSince = flagStr(flags, 'since');
  let sinceMtime: number | undefined;
  if (rawSince !== undefined) {
    sinceMtime = Number(rawSince);
    if (!Number.isFinite(sinceMtime)) {
      throw new UmbelUsageError(`wait: --since must be a numeric mtime, got '${rawSince}'`);
    }
  }

  // The same translation the MCP face uses, so a flag and a tool argument ask
  // for the same wait (umbel#98).
  const waitOpts = {
    name,
    env: getCliEnv(),
    ...waitRequest({
      name,
      until,
      ...(flagStr(flags, 'file') !== undefined ? { file: flagStr(flags, 'file') } : {}),
      ...(flagStr(flags, 'pattern') !== undefined ? { pattern: flagStr(flags, 'pattern') } : {}),
      ...(rawTimeout !== undefined ? { timeout: rawTimeout } : {}),
      ...(flagStr(flags, 'idle-timeout') !== undefined
        ? { idleTimeout: flagStr(flags, 'idle-timeout') }
        : {}),
      ...(sinceMtime !== undefined ? { sinceMtime } : {}),
    }),
  };

  const result = await waitFor(waitOpts);

  // JSON mode: emit a single JSON object on stdout, no human-readable output on
  // stderr. The exit code still carries the reason, so a caller can branch on
  // either.
  if (jsonMode) {
    const payload: {
      reason: string;
      inputReason?: string;
      message?: string;
      exitCode?: number;
      paneSnapshot?: string;
      runningCommands?: RunningCommand[];
      usage?: Usage;
    } = {
      reason: result.reason,
    };
    // What the worker is waiting for, as the MCP face reports it: a sign-in
    // needs a person, where a permission or a question can be answered.
    if (result.inputReason !== undefined) payload.inputReason = result.inputReason;
    if (result.message !== undefined && result.message.length > 0) {
      payload.message = result.message;
    }
    if (result.exitCode !== undefined) {
      payload.exitCode = result.exitCode;
    }
    if (result.runningCommands !== undefined) {
      payload.runningCommands = result.runningCommands;
    }
    if (result.usage !== undefined) {
      payload.usage = result.usage;
    }
    // The last screen goes in the JSON, not only on stderr: a caller branching
    // on this object has nothing else to read, and when the worker died it is
    // the only account of what it was doing.
    if (result.paneSnapshot !== undefined && result.paneSnapshot.trim().length > 0) {
      payload.paneSnapshot = result.paneSnapshot;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return WAIT_EXIT_CODES[result.reason];
  }

  if (result.reason === 'timeout') {
    if (result.paneSnapshot !== undefined && result.paneSnapshot.trim().length > 0) {
      process.stderr.write(`umbel: wait timed out. Last tmux pane:\n${result.paneSnapshot}\n`);
    }
  }
  if (result.reason === 'dead') {
    const cause = result.message !== undefined ? ` (${result.message})` : '';
    process.stderr.write(
      `umbel: wait failed — session '${name}' died before completing its turn${cause}.\n`,
    );
  }
  if (result.reason === 'stop' && result.message !== undefined) {
    process.stderr.write(`umbel: ${result.message}\n`);
  }
  if (result.reason === 'stop' && result.runningCommands !== undefined) {
    const count = result.runningCommands.length;
    if (count > 0) {
      const names = result.runningCommands.map((c) => c.command).join(', ');
      process.stderr.write(
        `umbel: session '${name}' stopped with ${count} command${count === 1 ? '' : 's'} still running: ${names}\n`,
      );
    }
  }
  if (result.reason === 'input' || result.reason === 'idle' || result.reason === 'provider-error') {
    const hasMsg = result.message !== undefined && result.message.length > 0;
    const detail = hasMsg ? ` — ${result.message}` : '';
    const state = {
      input: 'is waiting for input',
      idle: 'is idle',
      'provider-error': 'hit a provider error',
    }[result.reason];
    process.stderr.write(`umbel: session '${name}' ${state}${detail}\n`);
    if (result.paneSnapshot !== undefined && result.paneSnapshot.trim().length > 0) {
      process.stderr.write(`${result.paneSnapshot}\n`);
    }
  }
  return WAIT_EXIT_CODES[result.reason];
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function verbStatus(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  const entries = await status({
    ...(name !== undefined ? { name } : {}),
    ...listFilter(flags),
    env: getCliEnv(),
  });
  // --json: machine-readable for shell/CI watchers (no MCP needed). With no name
  // it lists live sessions; each entry carries needsInput/needsInputReason/pendingTool.
  if (flagBool(flags, 'json')) {
    process.stdout.write(`${JSON.stringify(entries)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write('No sessions found.\n');
    return 0;
  }
  printStatusTable(entries);
  return 0;
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

async function verbLs(flags: Map<string, string | boolean>): Promise<number> {
  const entries = await status({ ...listFilter(flags), env: getCliEnv() });
  if (flagBool(flags, 'json')) {
    process.stdout.write(`${JSON.stringify(entries)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write('No sessions found.\n');
    return 0;
  }
  printStatusTable(entries);
  return 0;
}

// ---------------------------------------------------------------------------
// kill
// ---------------------------------------------------------------------------

async function verbKill(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const prefix = flagStr(flags, 'prefix');
  const repo = flagStr(flags, 'repo');
  // A bare --prefix or --repo parses as a boolean. Say what it needs instead of
  // treating it as absent and falling through to "no selector".
  if (prefix === undefined && flags.has('prefix')) {
    throw new UmbelUsageError('--prefix needs a value: --prefix NAME-PREFIX');
  }
  if (repo === undefined && flags.has('repo')) {
    throw new UmbelUsageError('--repo needs a path: --repo PATH');
  }
  const request = killRequest({
    names: positionals,
    ...(prefix !== undefined ? { prefix } : {}),
    ...(repo !== undefined ? { repo } : {}),
    dryRun: flagBool(flags, 'dry-run'),
    purge: flagBool(flags, 'purge'),
  });
  const results = await killMany({ ...request, env: getCliEnv() });
  if (results.length === 0) {
    process.stdout.write(`no live sessions matched ${selectorLabel(request)}\n`);
    return 0;
  }
  for (const result of results) process.stdout.write(`${resultLine(result, request.dryRun)}\n`);
  // A name that was never a session is as much a miss as one that failed: the
  // caller asked for a fleet and did not get all of it.
  return results.some((r) => r.outcome === 'not-found' || r.outcome === 'failed') ? 1 : 0;
}

function resultLine(result: KillResult, dryRun: boolean): string {
  switch (result.outcome) {
    case 'killed':
      return dryRun ? `would kill ${result.name}` : `killed ${result.name}`;
    case 'already-dead':
      return dryRun ? `would skip ${result.name} (already dead)` : `already dead ${result.name}`;
    case 'not-found':
      return `not found ${result.name}`;
    case 'failed':
      return `failed ${result.name}: ${result.error ?? 'unknown error'}`;
  }
}

function selectorLabel(request: KillRequest): string {
  return [
    ...(request.prefix !== undefined ? [`--prefix ${request.prefix}`] : []),
    ...(request.repo !== undefined ? [`--repo ${request.repo}`] : []),
  ].join(' ');
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

async function verbPrune(flags: Map<string, string | boolean>): Promise<number> {
  const olderThan = flagStr(flags, 'older-than');
  const result = await prune({
    env: getCliEnv(),
    ...(olderThan !== undefined ? { olderThanMs: parseDuration(olderThan) } : {}),
  });
  for (const name of result.removed) {
    process.stdout.write(`removed ${name}\n`);
  }
  process.stdout.write(`${result.removed.length} removed, ${result.kept.length} kept\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

async function verbAttach(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name === undefined) throw new UmbelUsageError('attach: <name> is required');
  return await defaultDeps.tmux.attach(name, getCliEnv());
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

async function verbRead(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name === undefined) throw new UmbelUsageError('read: <name> is required');
  const cliEnv = getCliEnv();
  const session = await defaultDeps.fs.readMeta(name, cliEnv);
  const provider = getProvider(session.provider);
  const content = await resolveTranscriptContent({
    name,
    cwd: session.cwd,
    sinceMs: session.createdAt,
    provider,
    env: cliEnv,
  });
  const text = provider.parseTranscript(content);
  if (flagBool(flags, 'json')) {
    const usage = provider.extractUsage?.(content);
    process.stdout.write(
      `${JSON.stringify({ text, ...(usage !== undefined ? { usage } : {}) })}\n`,
    );
    return 0;
  }
  process.stdout.write(`${text}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// actions — structured digest of what a worker did
// ---------------------------------------------------------------------------

async function verbActions(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name === undefined) throw new UmbelUsageError('actions: <name> is required');
  if (flagBool(flags, 'json')) {
    const manifest = await actionsManifest({ name, env: getCliEnv() });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return 0;
  }
  const text = await actions({ name, env: getCliEnv() });
  process.stdout.write(`${text}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// diff — unified text diff between two turns
// ---------------------------------------------------------------------------

async function verbDiff(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name === undefined) throw new UmbelUsageError('diff: <name> is required');
  const fromStr = flagStr(flags, 'from');
  const toStr = flagStr(flags, 'to');
  const text = await diff({
    name,
    env: getCliEnv(),
    ...(fromStr !== undefined ? { from: Number.parseInt(fromStr, 10) } : {}),
    ...(toStr !== undefined ? { to: Number.parseInt(toStr, 10) } : {}),
  });
  process.stdout.write(`${text}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

async function verbCapture(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name === undefined) throw new UmbelUsageError('capture: <name> is required');
  const linesStr = flagStr(flags, 'lines');
  const { text, source } = await capture({
    name,
    env: getCliEnv(),
    ...(linesStr !== undefined ? { lines: Number.parseInt(linesStr, 10) } : {}),
  });
  // The pane is gone, so this is the screen as it was when the session was
  // torn down — said on stderr so a pipe still gets only the screen.
  if (source === 'dead') {
    process.stderr.write(`umbel: ${name} has no pane; last screen from events/dead\n`);
  }
  process.stdout.write(text);
  return 0;
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

async function verbLogs(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name === undefined) throw new UmbelUsageError('logs: <name> is required');
  const follow = flagBool(flags, 'follow', 'f');
  const logPath = join(defaultDeps.fs.eventsDir(name, getCliEnv()), 'log');

  let content = '';
  try {
    content = await readFile(logPath, 'utf8');
  } catch {
    // file absent is fine
  }
  process.stdout.write(content);

  if (!follow) return 0;

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());

  return await new Promise<number>((resolve) => {
    let seen = content;
    const interval = setInterval(async () => {
      if (ac.signal.aborted) {
        clearInterval(interval);
        resolve(0);
        return;
      }
      try {
        const fresh = await readFile(logPath, 'utf8');
        if (fresh.length > seen.length) {
          process.stdout.write(fresh.slice(seen.length));
          seen = fresh;
        }
      } catch {
        // ignore
      }
    }, 200);
  });
}

// ---------------------------------------------------------------------------
// run (workflow)
// ---------------------------------------------------------------------------

async function verbRun(positionals: string[]): Promise<number> {
  const file = positionals[0];
  if (file === undefined) throw new UmbelUsageError('run: <file> is required');
  const result = await runWorkflow({ file });
  if (result.status === 'failed') {
    const step = result.failedStep;
    process.stderr.write(
      step !== undefined
        ? `umbel: workflow failed at step '${step.worker}': ${step.reason}\n`
        : 'umbel: workflow failed\n',
    );
    return 1;
  }
  process.stdout.write(`workflow completed: runId=${result.runId}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

async function verbMcp(): Promise<number> {
  // The same environment every other verb forwards. Started with none, the
  // server worked on ~/.umbel whatever UMBEL_STATE said (umbel#98).
  await runMcpServer({ env: getCliEnv() });
  return 0;
}
