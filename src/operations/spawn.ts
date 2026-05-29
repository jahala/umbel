import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RctrlUsageError } from '../core/errors.ts';
import { generateSessionName, isValidSessionName } from '../core/id.ts';
import { getProvider } from '../core/providers/registry.ts';
import { nextStartupDialog, type StartupDialog } from '../core/startup-dialogs.ts';
import type { Session } from '../core/types.ts';
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
  if (dialogs.length === 0) return;
  const deadline = Date.now() + DIALOG_POLL_TIMEOUT_MS;
  const fired = new Set<number>();

  while (Date.now() < deadline && fired.size < dialogs.length) {
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

    // No pending dialog matched. If the main UI is up and we've handled
    // everything visible, we're done (covers already-trusted cwds where no
    // dialog ever appears).
    if (readyMatch !== undefined && readyMatch.test(pane)) {
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

  // Install global stop hook
  const { stopScriptPath } = await d.hooks.ensureGlobalHooks(env);

  // Create session directory
  await d.fs.ensureSessionDir(name, env);

  // Ask the provider how to launch. The provider encapsulates all
  // provider-specific arg building (settings JSON, model flag, etc.).
  const provider = getProvider(providerName);
  const launchSpec = provider.buildLaunch({
    sessionId: name,
    cwd: opts.cwd,
    hookScriptPath: stopScriptPath,
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

  // Build env for tmux session. A curated subset of process.env is inherited
  // so claude/codex/gemini are findable on PATH and basic locale works.
  // SHELL/PROMPT_COMMAND/BASH_ENV/ZDOTDIR are deliberately EXCLUDED — passing
  // them causes bash to emit a startup byte to the pane's stdin which races
  // the first send-keys and gets consumed as an empty prompt. Explicit `env`
  // passed in opts wins. RCTRL_STATE/RCTRL_SESSION_ID are always set so the
  // stop hook can locate the session dir.
  const stateRoot = d.fs.stateDir(env);
  const SAFE_INHERITED = new Set(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']);
  const tmuxEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SAFE_INHERITED.has(k) || k.startsWith('FAKE_CLAUDE_')) {
      tmuxEnv[k] = v;
    }
  }
  // Merge provider-specific env (over the safe-inherited set).
  for (const [k, v] of Object.entries(launchSpec.env)) {
    tmuxEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) tmuxEnv[k] = v;
  }
  tmuxEnv.RCTRL_STATE = stateRoot;
  tmuxEnv.RCTRL_SESSION_ID = name;

  try {
    await d.tmux.newSession({
      name,
      cwd: opts.cwd,
      cmd,
      env: tmuxEnv,
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
