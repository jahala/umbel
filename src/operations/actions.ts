import { RctrlUsageError, SessionDeadError } from '../core/errors.ts';
import { getProvider } from '../core/providers/registry.ts';
import type { ActionManifest } from '../core/providers/types.ts';
import type { Deps } from './deps.ts';
import { defaultDeps } from './deps.ts';
import { resolveTranscriptContent } from './resolve-transcript.ts';

// ---------------------------------------------------------------------------
// actions — read a session's transcript and return an agent-facing text
// digest of what the worker DID (tools used, files touched, errors, final
// message). Composes the per-provider extractActions extractor with a text
// formatter so the orchestrator gets a small string instead of a big JSON.
// ---------------------------------------------------------------------------

export interface ActionsOpts {
  name: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<Deps>;
}

// Machine-readable path: the raw manifest, for code callers (`actions --json`).
// Throws SessionDeadError when there is no transcript yet and RctrlUsageError
// when the provider has no extractor — callers that want prose use actions().
export async function actionsManifest(opts: ActionsOpts): Promise<ActionManifest> {
  const d = { ...defaultDeps, ...opts.deps };
  const env = opts.env ?? {};

  const session = await d.fs.readMeta(opts.name, env);
  const provider = getProvider(session.provider);
  if (provider.extractActions === undefined) {
    throw new RctrlUsageError(
      `actions extraction not implemented for provider: ${session.provider}`,
    );
  }

  const content = await resolveTranscriptContent({
    name: opts.name,
    cwd: session.cwd,
    sinceMs: session.createdAt,
    provider,
    env,
    ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
  });

  return provider.extractActions(content);
}

export async function actions(opts: ActionsOpts): Promise<string> {
  let manifest: ActionManifest;
  try {
    manifest = await actionsManifest(opts);
  } catch (err) {
    if (err instanceof SessionDeadError) return '(no transcript yet)';
    if (err instanceof RctrlUsageError) return `(${err.message})`;
    throw err;
  }
  return formatManifest(manifest);
}

// ---------------------------------------------------------------------------
// formatManifest — pure formatter. Empty sections omitted so the manifest
// stays tight when a worker only used a subset of tools.
// ---------------------------------------------------------------------------

export function formatManifest(m: ActionManifest): string {
  const lines: string[] = [];

  const turnLabel = m.turnCount === 1 ? 'turn' : 'turns';
  lines.push(`## Worker actions (${m.turnCount} ${turnLabel})`);
  lines.push('');

  const toolEntries = Object.entries(m.toolsUsed);
  if (toolEntries.length > 0) {
    const summary = toolEntries.map(([name, count]) => `${name}×${count}`).join(', ');
    lines.push(`Tools: ${summary}`);
  }

  if (m.filesRead.length > 0) {
    lines.push(`Files read: ${m.filesRead.join(', ')}`);
  }
  if (m.filesEdited.length > 0) {
    lines.push(`Files edited: ${m.filesEdited.join(', ')}`);
  }
  if (m.filesWritten.length > 0) {
    lines.push(`Files written: ${m.filesWritten.join(', ')}`);
  }
  if (m.bashCommands.length > 0) {
    // Each on its own line for readability; truncate noisy ones.
    lines.push('Bash:');
    for (const cmd of m.bashCommands) {
      lines.push(`  ${truncateOneLine(cmd, 200)}`);
    }
  }

  if (m.errors.length > 0) {
    lines.push('');
    lines.push(`## Errors (${m.errors.length})`);
    for (const err of m.errors) {
      lines.push(`- ${truncateOneLine(err, 300)}`);
    }
  }

  lines.push('');
  lines.push('## Final message');
  lines.push(m.finalMessage.length > 0 ? m.finalMessage : '(no final message yet)');

  return lines.join('\n');
}

function truncateOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, ' ⏎ ');
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}
