import { RctrlUsageError } from '../core/errors.ts';
import { generateSessionName, isValidSessionName } from '../core/id.ts';
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
function isRealClaudeBin(claudeBin: string): boolean {
  return claudeBin === 'claude' || /(^|\/)claude$/.test(claudeBin);
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
  model?: 'opus' | 'sonnet' | 'haiku';
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
  const claudeBin = opts.claudeBin ?? 'claude';

  const name = opts.name ?? generateSessionName('anon');

  if (!isValidSessionName(name)) {
    throw new RctrlUsageError(`Invalid session name: ${name}`);
  }

  const anonymous = opts.anonymous ?? opts.name === undefined;

  // Install global stop hook
  const { stopScriptPath } = await d.hooks.ensureGlobalHooks(env);

  // Create session directory
  await d.fs.ensureSessionDir(name, env);

  // Build settings JSON (inline, no collision with existing settings files)
  const settingsJson = d.hooks.buildSettingsJson(
    opts.allowedTools !== undefined
      ? { hookScriptPath: stopScriptPath, allowedTools: opts.allowedTools }
      : { hookScriptPath: stopScriptPath },
  );

  // Build claude command args
  const claudeArgs: string[] = [claudeBin, '--settings', settingsJson];
  if (opts.model !== undefined) {
    claudeArgs.push('--model', opts.model);
  }

  const sinceMs = Date.now();

  // Build env for tmux session. By default the spawned claude inherits the
  // parent rctrl process env (PATH for tools, HOME, FAKE_CLAUDE_* for tests).
  // Explicit `env` passed in opts wins. RCTRL_STATE/RCTRL_SESSION_ID are
  // always overridden so the stop hook can locate the session dir.
  const stateRoot = d.fs.stateDir(env);
  const tmuxEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) tmuxEnv[k] = v;
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
      cmd: claudeArgs,
      env: tmuxEnv,
    });
  } catch (err) {
    await d.tmux.killSession(name).catch(() => undefined);
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  // Dismiss the workspace-trust dialog if running real claude. Skipped for
  // fixtures and non-claude providers so they don't pay the polling cost.
  if (isRealClaudeBin(claudeBin)) {
    await dismissTrustDialog(d, name).catch(() => undefined);
  }

  // jsonlPath is unknown at spawn-time: real claude doesn't create the
  // transcript file until the first user message arrives. The Stop hook
  // payload contains transcript_path; we capture it then. See
  // src/adapters/hooks.ts STOP_HOOK_SCRIPT and docs/multi-cli.md.
  const session: Session = SessionSchema.parse({
    name,
    cwd: opts.cwd,
    model: opts.model,
    anonymous,
    createdAt: sinceMs,
    jsonlPath: null,
  });

  try {
    await d.fs.writeMeta(name, session, env);
  } catch (err) {
    await d.tmux.killSession(name).catch(() => undefined);
    await d.fs.rmSession(name, env).catch(() => undefined);
    throw err;
  }

  return { session, jsonlPath: '' };
}
