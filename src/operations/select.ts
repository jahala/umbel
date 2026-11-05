import { resolve } from 'node:path';
import { UmbelUsageError } from '../core/errors.ts';
import type { Deps } from './deps.ts';

// ---------------------------------------------------------------------------
// Selection — the sessions a cleanup verb was told to take
// ---------------------------------------------------------------------------
//
// `kill` and `prune` both take one or more names, or a selector over recorded
// sessions: a name prefix and a repository, and every selector given must
// match. The two verbs answer "which sessions did you mean" the same way, so a
// conductor that learned `kill --prefix run-42` reads `prune --prefix run-42`
// without a second thought (umbel#94, umbel#170).

export interface Selection {
  // These sessions exactly.
  names?: string[];
  // Sessions whose name starts with this.
  prefix?: string;
  // Sessions of this repository, as recorded at spawn.
  repo?: string;
}

export interface SessionCandidate {
  name: string;
  repo: string | null;
}

// PURE. Exactly one form: names take sessions that may be dead, a selector is
// read over the candidates the caller listed.
export function checkSelection(verb: string, selection: Selection): void {
  const names = selection.names ?? [];
  const selecting = selection.prefix !== undefined || selection.repo !== undefined;
  if (names.length > 0 && selecting) {
    throw new UmbelUsageError(
      `${verb}: name the sessions or select them with prefix/repo, not both.`,
    );
  }
  if (names.length === 0 && !selecting) {
    throw new UmbelUsageError(`${verb}: give a session name, or select with prefix or repo.`);
  }
}

// PURE. The sessions the selection picks, in candidate order. A candidate
// matches when it matches every selector given.
export function selectSessions(
  selection: Selection,
  candidates: readonly SessionCandidate[],
  wantedRepo: string | undefined,
): string[] {
  const names = selection.names ?? [];
  if (names.length > 0) return [...new Set(names)];
  return candidates
    .filter(
      (candidate) =>
        (selection.prefix === undefined || candidate.name.startsWith(selection.prefix)) &&
        (wantedRepo === undefined || candidate.repo === wantedRepo),
    )
    .map((candidate) => candidate.name);
}

// The repository a --repo path names, as a session records it: the top-level of
// the main working tree, so a linked worktree meets its siblings (umbel#65).
// A path git no longer knows is matched as given, which keeps a session of a
// deleted repository findable by the path it recorded.
export async function resolveWantedRepo(path: string, d: Pick<Deps, 'git'>): Promise<string> {
  return (await d.git.repoRoot(path)) ?? resolve(path);
}
