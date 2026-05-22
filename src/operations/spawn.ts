import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RctrlUsageError } from '../core/errors.ts';
import { generateSessionName, isValidSessionName } from '../core/id.ts';
import { getProvider } from '../core/providers/registry.ts';
import type { Session } from '../core/types.ts';
import { SessionSchema } from '../core/types.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';

// Auto-dismiss the workspace-trust dialog. Real claude shows this on first
// launch in every fresh cwd; the default option ("Yes, I trust this folder")
// is selected, so a single Enter dismisses it. We poll capture-pane briefly
// and bail as soon as either (a) the trust prompt appears (dismiss + return)
// or (b) any substantive content renders (UI is past the dialog → return).
const TRUST_PROMPT_RE = /trust this folder|trust this directory/i;
const TRUST_POLL_INTERVAL_MS = 100;
const TRUST_POLL_TIMEOUT_MS = 5000;
const TRUST_PANE_CONTENT_THRESHOLD = 120;

// Real claude binary detection: only the actual claude TUI shows the trust
// dialog. Skip dismissal for fixtures (fake-claude.sh) and future provider
// binaries (codex, gemini) — they have their own startup contracts.
function isRealClaudeBin(bin: string): boolean {
  return bin === 'claude' || /(^|\/)claude$/.test(bin);
}

async function dismissTrustDialog(d: Deps, name: string): Promise<void> {
  const deadline = Date.now() + TRUST_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let pane = '';
    try {
      pane = await d.tmux.capturePane(name, 30);
    } catch {
      return;
    }
    if (TRUST_PROMPT_RE.test(pane)) {
      try {
        await d.tmux.sendText(name, '\n');
      } catch {
        // best-effort; ignore
      }
      return;
    }
    // UI has rendered something else (welcome screen, main prompt, etc.) — we
    // are past the trust dialog.
    if (pane.trim().length > TRUST_PANE_CONTENT_THRESHOLD) {
      return;
    }
    await Bun.sleep(TRUST_POLL_INTERVAL_MS);
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
  // provider config into the user's cwd. See docs/audit-C.md §F3.
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
    // See docs/audit-C.md §F1.
    for (const filePath of providerFilePaths) {
      await unlink(filePath).catch(() => undefined);
    }
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  if (isRealClaudeBin(bin)) {
    await dismissTrustDialog(d, name).catch(() => undefined);
  } else {
    await Bun.sleep(800);
  }

  // jsonlPath is unknown at spawn-time: real claude doesn't create the
  // transcript file until the first user message arrives. The Stop hook
  // payload contains transcript_path; we capture it then. See
  // src/adapters/hooks.ts STOP_HOOK_SCRIPT and docs/multi-cli.md.
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
    // Clean up provider files — see docs/audit-C.md §F2.
    for (const filePath of providerFilePaths) {
      await unlink(filePath).catch(() => undefined);
    }
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  return { session, jsonlPath: '' };
}
