import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AllowedToolsUnsupportedError,
  EnvRefUnresolvedError,
  HookTimeoutError,
  JsonlMalformedError,
  ProviderUnknownError,
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
import { getProvider } from '../core/providers/registry.ts';
import { SessionNameSchema } from '../core/types.ts';
import { actions, actionsManifest } from '../operations/actions.ts';
import { defaultDeps } from '../operations/deps.ts';
import { diff } from '../operations/diff.ts';
import { kill } from '../operations/kill.ts';
import { resolveTranscriptContent } from '../operations/resolve-transcript.ts';
import { send } from '../operations/send.ts';
import { spawn } from '../operations/spawn.ts';
import { status } from '../operations/status.ts';
import type { WaitCondition } from '../operations/wait.ts';
import { waitFor } from '../operations/wait.ts';
import { runMcpServer } from './mcp.ts';
import { runP } from './p.ts';
import { parseDuration } from './verbs.ts';
import { runWorkflow } from './workflow.ts';

const VERSION = '0.0.1';

const HELP = `umbel — remote-control interactive Claude Code over tmux

Usage:
  umbel <verb> [flags...]    Supervisor verbs
  umbel -p [PROMPT]          Drop-in for claude -p
  umbel --help               Show this help
  umbel --version            Show version

Verbs:
  spawn   Create a new session
  send    Send a prompt to a session
  wait    Wait for a session to finish
  status  Show session status
  ls      List all sessions
  kill    Kill a session
  attach  Attach to a session
  read    Read last assistant message
  actions Digest of what a worker did (tools, files, errors)
  diff    Text diff between two turns of a session
  capture Capture last N tmux pane lines
  logs    Tail session event log
  run     Run a workflow YAML file
  mcp     Start MCP server

Exit codes:
  0    Success
  1    Generic error (session dead, tmux failure, JSONL malformed, hook timeout,
       session not created, provider has no unattended mode)
  2    Usage error (bad flags, missing required argument, unknown verb, unsupported option)
  123  wait idle — no pane activity for --idle-timeout
  124  wait timeout — hard deadline hit
  125  wait dead — worker exited before finishing its turn
  126  wait input — worker is blocked waiting for input (permission / prompt)
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
  'keep-state',
  'keepState',
  'unattended',
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

// Parse repeated `--env KEY=VALUE` flags into an override map. Throws on a
// malformed entry (no '=' or empty key) so the user sees the error instead of
// a silently-dropped var.
export function parseEnvFlags(entries: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new UmbelUsageError(`Invalid --env '${entry}'. Use --env KEY=VALUE.`);
    }
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
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

function printStatusTable(entries: StatusEntry[]): void {
  const rows = entries.map((e) => ({
    name: e.name,
    status: e.alive ? 'alive' : 'dead',
    model: e.model ?? '—',
    cwd: truncateCwd(e.cwd),
    created: formatTimestamp(e.createdAt),
    last: e.lastActivityAt !== undefined ? formatTimestamp(e.lastActivityAt) : '—',
  }));

  type RowKey = keyof (typeof rows)[0];
  const cols: Array<{ key: RowKey; header: string }> = [
    { key: 'name', header: 'NAME' },
    { key: 'status', header: 'STATUS' },
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
    err instanceof AllowedToolsUnsupportedError
  ) {
    return 2;
  }
  if (
    err instanceof SessionDeadError ||
    err instanceof TmuxError ||
    err instanceof HookTimeoutError ||
    err instanceof JsonlMalformedError ||
    err instanceof SessionNotFoundError ||
    err instanceof SessionNotCreatedError ||
    err instanceof UnattendedUnsupportedError
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
    process.stdout.write(HELP);
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
        return await verbLs();
      case 'kill':
        return await verbKill(flags, rest);
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
  // UMBEL_CLAUDE_BIN allows tests to inject a fake claude binary
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
  // UMBEL_CLAUDE_BIN allows tests to inject a fake claude binary
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
  const timeoutMs = rawTimeout !== undefined ? parseDuration(rawTimeout) : undefined;

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

  let condition: WaitCondition | undefined;
  if (until === 'file') {
    const file = flagStr(flags, 'file');
    if (file === undefined) throw new UmbelUsageError('wait: --file required when --until=file');
    condition = { kind: 'file', path: file };
  } else if (until === 'pattern') {
    const pat = flagStr(flags, 'pattern');
    if (pat === undefined)
      throw new UmbelUsageError('wait: --pattern required when --until=pattern');
    condition = { kind: 'pattern', session: SessionNameSchema.parse(name), regex: pat };
  }

  const rawIdle = flagStr(flags, 'idle-timeout');
  const idleTimeoutMs = rawIdle !== undefined ? parseDuration(rawIdle) : undefined;

  const waitOpts = {
    name,
    env: getCliEnv(),
    ...(condition !== undefined ? { condition } : {}),
    ...(timeoutMs !== undefined ? { defaultTimeoutMs: timeoutMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(sinceMtime !== undefined ? { sinceMtime } : {}),
  };

  const result = await waitFor(waitOpts);

  // JSON mode: emit a single JSON object on stdout and exit 0 regardless of
  // reason — the JSON is the signal. No human-readable output on stderr.
  if (jsonMode) {
    const payload: { reason: string; message?: string } = { reason: result.reason };
    if (result.message !== undefined && result.message.length > 0) {
      payload.message = result.message;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }

  if (result.reason === 'timeout') {
    if (result.paneSnapshot !== undefined && result.paneSnapshot.trim().length > 0) {
      process.stderr.write(`umbel: wait timed out. Last tmux pane:\n${result.paneSnapshot}\n`);
    }
    return 124;
  }
  if (result.reason === 'dead') {
    process.stderr.write(
      `umbel: wait failed — session '${name}' died before completing its turn.\n`,
    );
    return 125;
  }
  if (result.reason === 'input') {
    const hasMsg = result.message !== undefined && result.message.length > 0;
    const detail = hasMsg ? ` — ${result.message}` : '';
    process.stderr.write(`umbel: session '${name}' is waiting for input${detail}\n`);
    if (result.paneSnapshot !== undefined && result.paneSnapshot.trim().length > 0) {
      process.stderr.write(`${result.paneSnapshot}\n`);
    }
    return 126;
  }
  if (result.reason === 'idle') {
    process.stderr.write(`umbel: session '${name}' is idle — no pane activity.\n`);
    if (result.paneSnapshot !== undefined && result.paneSnapshot.trim().length > 0) {
      process.stderr.write(`${result.paneSnapshot}\n`);
    }
    return 123;
  }
  if (result.reason === 'aborted') return 130;
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function verbStatus(
  flags: Map<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const name = flagStr(flags, 'name') ?? positionals[0];
  const statusOpts = name !== undefined ? { name, env: getCliEnv() } : { env: getCliEnv() };
  const entries = await status(statusOpts);
  // --json: machine-readable for shell/CI watchers (no MCP needed). With no name
  // it lists every session; each entry carries needsInput/needsInputReason/pendingTool.
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

async function verbLs(): Promise<number> {
  const entries = await status({ env: getCliEnv() });
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
  const name = flagStr(flags, 'name') ?? positionals[0];
  if (name === undefined) throw new UmbelUsageError('kill: <name> is required');
  const keepState = flagBool(flags, 'keep-state', 'keepState');
  await kill({ name, removeState: !keepState, env: getCliEnv() });
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
  const proc = Bun.spawn(['tmux', 'attach', '-t', `umbel-${name}`], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  return typeof code === 'number' ? code : 0;
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
  const lines = linesStr !== undefined ? Number.parseInt(linesStr, 10) : 100;
  process.stdout.write(await defaultDeps.tmux.capturePane(name, lines));
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
  await runMcpServer({});
  return 0;
}
