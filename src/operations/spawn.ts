import { access, copyFile, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveEnvRefs } from '../core/env.ts';
import {
  AllowedToolsUnsupportedError,
  ModelListUnavailableError,
  OpencodeModelUnknownError,
  SessionNotCreatedError,
  UmbelUsageError,
  UnattendedUnsupportedError,
} from '../core/errors.ts';
import { generateSessionName, isValidSessionName } from '../core/id.ts';
import { getProvider } from '../core/providers/registry.ts';
import type { ProviderLaunchSpec } from '../core/providers/types.ts';
import { nextStartupDialog, type StartupDialog } from '../core/startup-dialogs.ts';
import type { EnvValue, Session } from '../core/types.ts';
import { SessionSchema } from '../core/types.ts';
import { envExports, inheritedEnv } from '../core/worker-env.ts';
import { readDeathCause } from './death-record.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// Auto-dismiss a provider's interactive startup dialogs (workspace-trust /
// hook-review prompts). Generic over providers: each declares its dialogs in
// `provider.startupDialogs`; we poll capture-pane and send each dialog's keys
// as it appears. Dialogs are dismissed in declared order (later ones only
// render after earlier ones clear). Bails early when every declared dialog has
// been handled OR the provider's readyMatch shows the main UI is up
// (already-trusted cwd → no dialogs appear). Best-effort throughout — never
// throws.
const DIALOG_POLL_INTERVAL_MS = 150;
const DIALOG_POLL_TIMEOUT_MS = 8000;
const DIALOG_KEY_SETTLE_MS = 300;
// A dialog still on the pane after its keys were sent swallowed them: the TUI
// had rendered but was not yet reading input. Re-send rather than move on, but
// cap it — retrying is what makes typing forever into a live agent possible.
const MAX_DIALOG_ATTEMPTS = 3;

export async function dismissStartupDialogs(
  d: Pick<Deps, 'tmux'>,
  name: string,
  dialogs: readonly StartupDialog[],
  readyMatch?: RegExp,
  readySettleMs?: number,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  // Nothing to wait for: no dialogs to dismiss AND no ready signal to poll for.
  if (dialogs.length === 0 && readyMatch === undefined) return;
  const deadline = Date.now() + DIALOG_POLL_TIMEOUT_MS;
  // Keystrokes sent per dialog. Its size doubles as "dialogs handled at least
  // once", which is how a provider with no readyMatch knows it is done.
  const attempts = new Map<number, number>();
  const exhausted = new Set<number>();
  // The ready pane and when it was first seen unchanged. Any change, a dialog,
  // or losing readyMatch restarts the settle window.
  let settling: { pane: string; since: number } | null = null;

  while (Date.now() < deadline) {
    let pane = '';
    try {
      pane = await d.tmux.capturePane(name, 40, env);
    } catch {
      return;
    }

    // The worker died during startup. Its pane is kept (remain-on-exit), so the
    // capture above succeeds and would otherwise keep this loop typing at a
    // corpse until the timeout. Stop; spawn's startup check reads the same pane
    // and reports the exit status.
    try {
      if ((await d.tmux.paneState(name, env)).dead) return;
    } catch {
      // Probe failed — treat as alive and keep polling; the deadline bounds it.
    }

    const idx = nextStartupDialog(pane, dialogs, exhausted);
    if (idx !== null) {
      const dialog = dialogs[idx];
      if (dialog !== undefined) {
        try {
          await d.tmux.sendKeys(name, dialog.keys, env);
        } catch {
          // best-effort; ignore
        }
        const n = (attempts.get(idx) ?? 0) + 1;
        attempts.set(idx, n);
        if (n >= MAX_DIALOG_ATTEMPTS) exhausted.add(idx);
        settling = null;
        // Give the TUI a moment to render the next dialog (or the main UI)
        // before the next capture. A dismissed dialog stops matching, so the
        // next pass moves on by itself.
        await Bun.sleep(DIALOG_KEY_SETTLE_MS);
        continue;
      }
    }

    // No pending dialog matched.
    if (readyMatch !== undefined) {
      // Poll until the main UI renders. This doubles as a warm-up for
      // dialog-less providers (e.g. opencode) so the first send doesn't race
      // the TUI's boot and get dropped.
      if (!readyMatch.test(pane)) {
        settling = null;
      } else if (readySettleMs === undefined) {
        return;
      } else if (settling === null || settling.pane !== pane) {
        settling = { pane, since: Date.now() };
      } else if (Date.now() - settling.since >= readySettleMs) {
        return;
      }
    } else if (attempts.size >= dialogs.length) {
      // No ready signal to wait for; done once all known dialogs are dismissed.
      return;
    }

    await Bun.sleep(DIALOG_POLL_INTERVAL_MS);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Materialize one provider launch file at the I/O edge: write its content, create
// a symlink (symlinkTo), or copy a source (copyFrom; ifAbsent skips when the dest
// exists, and a missing source is skipped silently). Symlink/copy are idempotent
// so a shared provider home (CODEX_HOME) can be re-materialized by every worker.
async function materializeFile(f: ProviderLaunchSpec['files'][number]): Promise<void> {
  await mkdir(dirname(f.path), { recursive: true });
  if ('symlinkTo' in f) {
    await symlink(f.symlinkTo, f.path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  } else if ('copyFrom' in f) {
    if (f.ifAbsent === true && (await pathExists(f.path))) return;
    if (!(await pathExists(f.copyFrom))) return;
    await copyFile(f.copyFrom, f.path);
  } else {
    await writeFile(f.path, f.content, { mode: f.mode ?? 0o644 });
  }
}

// ---------------------------------------------------------------------------
// SpawnOpts / SpawnResult
// ---------------------------------------------------------------------------

export interface SpawnOpts {
  name?: string;
  cwd: string;
  model?: string;
  provider?: string;
  allowedTools?: string;
  permissionMode?: string;
  unattended?: boolean;
  anonymous?: boolean;
  claudeBin?: string;
  env?: Record<string, string | undefined>;
  // Explicit per-worker environment overrides (e.g. from `--env KEY=VAL`).
  // Values may be literals or {fromEnv} references; merged OVER the inherited
  // environment after resolution. Never persisted to meta.json.
  workerEnv?: Record<string, EnvValue>;
  deps?: Partial<Deps>;
}

export interface SpawnResult {
  session: Session;
  jsonlPath: string;
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

export async function spawn(opts: SpawnOpts): Promise<SpawnResult> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};
  const providerName = opts.provider ?? 'claude';

  const name = opts.name ?? generateSessionName('anon');

  if (!isValidSessionName(name)) {
    throw new UmbelUsageError(`Invalid session name: ${name}`);
  }

  const anonymous = opts.anonymous ?? opts.name === undefined;

  // Resolve {fromEnv} references against the umbel server's env BEFORE any I/O,
  // so an unresolved reference fails fast (no session dir / hooks to clean up).
  const resolvedWorkerEnv =
    opts.workerEnv !== undefined ? resolveEnvRefs(opts.workerEnv, process.env) : undefined;

  // Resolve provider first — fails fast on unknown provider before any I/O.
  const provider = getProvider(providerName);

  // Guard: allowedTools is only wired in the Claude buildLaunch. Passing it to
  // any other provider silently does nothing — confusing and misleading. Throw
  // before any tmux/file side effects so the caller gets an honest error.
  if (opts.allowedTools !== undefined && providerName !== 'claude') {
    throw new AllowedToolsUnsupportedError(providerName);
  }
  // permissionMode: claude embeds it in --settings; codex maps the unattended
  // `bypassPermissions` intent to its approvals+sandbox bypass. Other providers
  // don't support it; codex rejects any other mode value.
  if (opts.permissionMode !== undefined) {
    if (providerName === 'codex') {
      if (opts.permissionMode !== 'bypassPermissions') {
        throw new UmbelUsageError(
          `codex --permission-mode supports only 'bypassPermissions' (maps to --dangerously-bypass-approvals-and-sandbox); got '${opts.permissionMode}'`,
        );
      }
    } else if (providerName !== 'claude') {
      throw new AllowedToolsUnsupportedError(providerName);
    }
  }
  // An unattended worker has nobody to answer a prompt. If the provider can't
  // suppress them, refuse here rather than accept the spawn and let it wedge on
  // a prompt hours later — the same doctrine as verifying the session exists.
  if (opts.unattended === true && !provider.supportsUnattended) {
    throw new UnattendedUnsupportedError(providerName);
  }

  // Install global stop hook
  const { stopScriptPath, notifyScriptPath, statusLineScriptPath, launchScriptPath } =
    await d.hooks.ensureGlobalHooks(env);

  // codex needs an isolated CODEX_HOME — a project .codex/hooks.json is ignored
  // inside linked git worktrees, so the Stop hook is delivered via a global
  // <stateDir>/codex-home/hooks.json instead. Resolve the umbel state root and
  // the user's real codex home (auth/config source) for the provider to declare
  // that home; other providers ignore both opts.
  const stateRoot = d.fs.stateDir(env);
  const userCodexHome = env.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');

  // Ask the provider how to launch. The provider encapsulates all
  // provider-specific arg building (settings JSON, model flag, etc.).
  const launchSpec = provider.buildLaunch({
    sessionId: name,
    cwd: opts.cwd,
    hookScriptPath: stopScriptPath,
    notifyScriptPath,
    statusLineScriptPath,
    stateDir: stateRoot,
    userCodexHome,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.unattended !== undefined ? { unattended: opts.unattended } : {}),
  });

  // claudeBin overrides the provider's default bin (used by tests to inject
  // fake-claude.sh). When not provided, use the provider's bin.
  const bin = opts.claudeBin ?? launchSpec.bin;
  // The wrapper takes the worker's environment from this buffer, records how the
  // worker ends into events/exit, and passes the worker's own argv through
  // untouched.
  const envBuffer = `umbel-env-${name}`;
  const cmd: string[] = [launchScriptPath, envBuffer, bin, ...launchSpec.args];

  // Build the worker's environment. It inherits only what any CLI needs to run
  // as its user and the variables its own provider reads (umbel#93): a worker
  // that received the caller's whole environment received every key in it.
  // Anything else is passed explicitly. Precedence (low→high): inherited <
  // operational env < explicit workerEnv override < provider launch env
  // (RESERVED) < UMBEL_STATE/UMBEL_SESSION_ID. The last two are forced so the
  // stop hook can always locate the session dir.
  const composedEnv: Record<string, string> = inheritedEnv(process.env, provider.inheritEnv ?? []);
  // Operational env (UMBEL_STATE, test-injected vars).
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) composedEnv[k] = v;
  }
  // Explicit per-worker overrides (--env) win over inherited + operational.
  if (resolvedWorkerEnv !== undefined) {
    for (const [k, v] of Object.entries(resolvedWorkerEnv)) {
      composedEnv[k] = v;
    }
  }
  // Provider launch env is RESERVED — umbel controls it, so it wins even over an
  // explicit --env: codex's CODEX_HOME must point at umbel's isolated home or the
  // Stop hook never fires. Every provider but codex declares an empty launch env.
  for (const [k, v] of Object.entries(launchSpec.env)) {
    composedEnv[k] = v;
  }
  composedEnv.UMBEL_STATE = stateRoot;
  composedEnv.UMBEL_SESSION_ID = name;

  // Let the provider reconcile mutually-exclusive credentials in the final env
  // (claude drops an inherited ANTHROPIC_API_KEY when a custom AUTH_TOKEN is
  // set — it would otherwise wedge the worker on the "use this key?" prompt).
  const workerEnvFinal = provider.reconcileEnv?.(composedEnv) ?? composedEnv;

  // Refuse a model the binary does not list before anything is created: the
  // probe runs the launch's binary with the launch's env and cwd, so it sees
  // the same provider config the worker would.
  if (opts.model !== undefined && provider.listModels !== undefined) {
    let out: string;
    try {
      out = await d.exec.run(provider.listModels(bin), { cwd: opts.cwd, env: workerEnvFinal });
    } catch (err) {
      throw new ModelListUnavailableError(
        opts.model,
        err instanceof Error ? err.message : String(err),
      );
    }
    const listed = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!listed.includes(opts.model)) throw new OpencodeModelUnknownError(opts.model, listed);
  }

  // Install provider-specific global plugin (e.g. opencode-stop.ts), if declared.
  if (provider.globalPlugin !== undefined) {
    await d.hooks.installGlobalPlugin(provider.globalPlugin, env);
  }

  // Create session directory
  await d.fs.ensureSessionDir(name, env);
  await d.fs.clearExit(name, env);

  // Write any provider-required files before tmux launch. If a later write
  // fails mid-list, unlink the ones already written so we don't leak partial
  // provider config into the user's cwd.
  const providerFilePaths: string[] = [];
  try {
    for (const f of launchSpec.files) {
      await materializeFile(f);
      // Shared infra (a provider's CODEX_HOME) is set up idempotently and reused
      // across workers — never tracked for per-session cleanup.
      if (f.shared !== true) providerFilePaths.push(f.path);
    }
  } catch (err) {
    for (const written of providerFilePaths) {
      await unlink(written).catch(() => undefined);
    }
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  const sinceMs = Date.now();

  // Every post-creation failure unwinds the same way: drop the session, then
  // the provider files written above so a failed spawn doesn't leak
  // .codex/hooks.json or .gemini/settings.json into the user's cwd, then state.
  const unwind = async (): Promise<void> => {
    await d.tmux.killSession(name, env).catch(() => undefined);
    // Holds the worker's environment until its wrapper reads it; a worker that
    // never ran leaves it behind in the server.
    await d.tmux.deleteBuffer(envBuffer, env);
    for (const filePath of providerFilePaths) {
      await unlink(filePath).catch(() => undefined);
    }
    await d.fs.rmSession(name, env).catch(() => undefined);
  };

  try {
    await d.tmux.newSession(
      {
        name,
        cwd: opts.cwd,
        cmd,
        envBuffer: { name: envBuffer, content: envExports(workerEnvFinal) },
      },
      env,
    );
  } catch (err) {
    await unwind();
    throw err;
  }

  // Fakes (opts.claudeBin) go through the same loop: each prints its provider's
  // ready line, so the e2e path is the real startup path. A provider with no
  // readyMatch (gemini) gives a fake nothing to print, and the loop would poll
  // to its timeout, so its fake keeps the warm-up.
  const fakeWithoutReadySignal = opts.claudeBin !== undefined && provider.readyMatch === undefined;
  if (provider.startupDialogs !== undefined && !fakeWithoutReadySignal) {
    await dismissStartupDialogs(
      d,
      name,
      provider.startupDialogs,
      provider.readyMatch,
      provider.readySettleMs,
      env,
    ).catch(() => undefined);
  } else {
    await Bun.sleep(800);
  }

  // Returning success is a promise to the caller that a worker exists to talk
  // to, and `tmux new-session -d` exiting 0 does not establish that (umbel#54):
  // it exits 0 once the server accepts the command, so a server that fails to
  // survive detachment leaves no session behind. The guarantee is point-in-time
  // — the session existed when spawn returned. A worker that dies later is the
  // wait layer's problem (reason: 'dead'), not something spawn can promise away.
  // Read the pane, not the session: with remain-on-exit a worker that refused to
  // start (bad flag, missing auth) leaves its session standing with a dead pane,
  // which has-session would have called success.
  const pane = await d.tmux.paneState(name, env);
  if (!pane.exists || pane.dead) {
    const cause = pane.dead ? await readDeathCause(d, name, pane, env) : undefined;
    await unwind();
    throw new SessionNotCreatedError(
      name,
      cause !== undefined ? { exitCode: cause.exitCode } : undefined,
    );
  }

  // jsonlPath is unknown at spawn-time: real claude doesn't create the
  // transcript file until the first user message arrives. The Stop hook
  // payload contains transcript_path; we capture it then.
  const session: Session = SessionSchema.parse({
    name,
    cwd: opts.cwd,
    model: opts.model,
    provider: providerName,
    providerFiles: providerFilePaths,
    anonymous,
    createdAt: sinceMs,
    jsonlPath: null,
    baseUrl: workerEnvFinal.ANTHROPIC_BASE_URL ?? null,
  });

  try {
    await d.fs.writeMeta(name, session, env);
  } catch (err) {
    await unwind();
    throw err;
  }

  return { session, jsonlPath: '' };
}
