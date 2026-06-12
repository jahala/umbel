import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveEnvRefs } from '../core/env.ts';
import { AllowedToolsUnsupportedError, RctrlUsageError } from '../core/errors.ts';
import { generateSessionName, isValidSessionName } from '../core/id.ts';
import { getProvider } from '../core/providers/registry.ts';
import { nextStartupDialog, type StartupDialog } from '../core/startup-dialogs.ts';
import type { EnvValue, Session } from '../core/types.ts';
import { SessionSchema } from '../core/types.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// Auto-dismiss a provider's interactive startup dialogs (workspace-trust /
// hook-review prompts). Generic over providers: each declares its dialogs in
// `provider.startupDialogs`; we poll capture-pane and send each dialog's keys
// as it appears. Dialogs are dismissed in declared order (later ones only
// render after earlier ones clear). Bails early when all known dialogs have
// fired OR the provider's readyMatch shows the main UI is up (already-trusted
// cwd → no dialogs appear). Best-effort throughout — never throws.
const DIALOG_POLL_INTERVAL_MS = 150;
const DIALOG_POLL_TIMEOUT_MS = 8000;
const DIALOG_KEY_SETTLE_MS = 300;

export async function dismissStartupDialogs(
  d: Pick<Deps, 'tmux'>,
  name: string,
  dialogs: readonly StartupDialog[],
  readyMatch?: RegExp,
): Promise<void> {
  // Nothing to wait for: no dialogs to dismiss AND no ready signal to poll for.
  if (dialogs.length === 0 && readyMatch === undefined) return;
  const deadline = Date.now() + DIALOG_POLL_TIMEOUT_MS;
  const fired = new Set<number>();

  while (Date.now() < deadline) {
    let pane = '';
    try {
      pane = await d.tmux.capturePane(name, 40);
    } catch {
      return;
    }

    const idx = nextStartupDialog(pane, dialogs, fired);
    if (idx !== null) {
      const dialog = dialogs[idx];
      if (dialog !== undefined) {
        try {
          await d.tmux.sendKeys(name, dialog.keys);
        } catch {
          // best-effort; ignore
        }
        fired.add(idx);
        // Give the TUI a moment to render the next dialog (or the main UI)
        // before the next capture.
        await Bun.sleep(DIALOG_KEY_SETTLE_MS);
        continue;
      }
    }

    // No pending dialog matched.
    if (readyMatch !== undefined) {
      // Poll until the main UI renders. This doubles as a warm-up for
      // dialog-less providers (e.g. opencode) so the first send doesn't race
      // the TUI's boot and get dropped.
      if (readyMatch.test(pane)) return;
    } else if (fired.size >= dialogs.length) {
      // No ready signal to wait for; done once all known dialogs are dismissed.
      return;
    }

    await Bun.sleep(DIALOG_POLL_INTERVAL_MS);
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
    throw new RctrlUsageError(`Invalid session name: ${name}`);
  }

  const anonymous = opts.anonymous ?? opts.name === undefined;

  // Resolve {fromEnv} references against the rctrl server's env BEFORE any I/O,
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

  // Install global stop hook
  const { stopScriptPath, notifyScriptPath } = await d.hooks.ensureGlobalHooks(env);

  // Install provider-specific global plugin (e.g. opencode-stop.ts), if declared.
  if (provider.globalPlugin !== undefined) {
    await d.hooks.installGlobalPlugin(provider.globalPlugin, env);
  }

  // Create session directory
  await d.fs.ensureSessionDir(name, env);

  // Ask the provider how to launch. The provider encapsulates all
  // provider-specific arg building (settings JSON, model flag, etc.).
  const launchSpec = provider.buildLaunch({
    sessionId: name,
    cwd: opts.cwd,
    hookScriptPath: stopScriptPath,
    notifyScriptPath,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
  });

  // Write any provider-required files before tmux launch. If a later write
  // fails mid-list, unlink the ones already written so we don't leak partial
  // provider config into the user's cwd.
  const providerFilePaths: string[] = [];
  try {
    for (const f of launchSpec.files) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, { mode: f.mode ?? 0o644 });
      providerFilePaths.push(f.path);
    }
  } catch (err) {
    for (const written of providerFilePaths) {
      await unlink(written).catch(() => undefined);
    }
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  // claudeBin overrides the provider's default bin (used by tests to inject
  // fake-claude.sh). When not provided, use the provider's bin.
  const bin = opts.claudeBin ?? launchSpec.bin;
  const cmd: string[] = [bin, ...launchSpec.args];

  const sinceMs = Date.now();

  // Build env for the tmux session. The worker runs with the user's
  // environment by default — it should behave like running the CLI yourself,
  // so an exported proxy / API key / config-dir reaches it — MINUS the
  // shell-init vars below: passing them makes the pane's login shell emit a
  // startup byte to stdin that races the first send-keys and gets consumed as
  // an empty prompt. Precedence (low→high): inherited < provider launch env <
  // operational env < explicit workerEnv override. RCTRL_STATE/RCTRL_SESSION_ID
  // are forced last so the stop hook can always locate the session dir.
  const stateRoot = d.fs.stateDir(env);
  const SHELL_INIT_DENYLIST = new Set(['SHELL', 'PROMPT_COMMAND', 'BASH_ENV', 'ZDOTDIR', 'ENV']);
  const tmuxEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SHELL_INIT_DENYLIST.has(k)) continue;
    tmuxEnv[k] = v;
  }
  // Provider-required env (over the inherited base).
  for (const [k, v] of Object.entries(launchSpec.env)) {
    tmuxEnv[k] = v;
  }
  // Operational env (RCTRL_STATE, test-injected vars).
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) tmuxEnv[k] = v;
  }
  // Explicit per-worker overrides win over everything except reserved vars.
  if (resolvedWorkerEnv !== undefined) {
    for (const [k, v] of Object.entries(resolvedWorkerEnv)) {
      tmuxEnv[k] = v;
    }
  }
  tmuxEnv.RCTRL_STATE = stateRoot;
  tmuxEnv.RCTRL_SESSION_ID = name;

  // Let the provider reconcile mutually-exclusive credentials in the final env
  // (claude drops an inherited ANTHROPIC_API_KEY when a custom AUTH_TOKEN is
  // set — it would otherwise wedge the worker on the "use this key?" prompt).
  const workerEnvFinal = provider.reconcileEnv?.(tmuxEnv) ?? tmuxEnv;

  try {
    await d.tmux.newSession({
      name,
      cwd: opts.cwd,
      cmd,
      env: workerEnvFinal,
    });
  } catch (err) {
    await d.tmux.killSession(name).catch(() => undefined);
    // Clean up provider files written above so a failed spawn doesn't leak
    // .codex/hooks.json or .gemini/settings.json into the user's cwd.
    for (const filePath of providerFilePaths) {
      await unlink(filePath).catch(() => undefined);
    }
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  // Auto-dismiss startup dialogs only for REAL provider binaries. Test
  // fixtures inject their bin via opts.claudeBin (fake-*.sh) and show no
  // dialogs — for them we just give the fixture a brief warm-up instead.
  if (opts.claudeBin === undefined && provider.startupDialogs !== undefined) {
    await dismissStartupDialogs(d, name, provider.startupDialogs, provider.readyMatch).catch(
      () => undefined,
    );
  } else {
    await Bun.sleep(800);
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
    await d.tmux.killSession(name).catch(() => undefined);
    for (const filePath of providerFilePaths) {
      await unlink(filePath).catch(() => undefined);
    }
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  return { session, jsonlPath: '' };
}
