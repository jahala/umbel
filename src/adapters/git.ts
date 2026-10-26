import {
  parseLog,
  parseNumstat,
  parseStatusV2,
  type Workspace,
  type WorkspaceCommit,
  type WorkspaceDiffStat,
} from '../core/workspace.ts';
import { run } from './exec.ts';

// The whole git call set behind one status entry is bounded: a status call
// must answer now, whatever a repository in the worker's cwd is busy with
// (umbel#153). The bound covers the set, not each call.
export const GIT_CALL_TIMEOUT_MS = 5_000;

// Every read carries --no-optional-locks. A plain `git status` refreshes the
// index when a file's stat info is stale, taking `.git/index.lock` for a
// moment, and a worker committing at that instant fails with "index.lock
// exists". A read that fails or does not answer is null: one unreadable tree
// never fails a listing.
async function gitOut(path: string, args: string[], timeoutMs: number): Promise<string | null> {
  try {
    return await run(['git', '--no-optional-locks', '-C', path, ...args], { timeoutMs });
  } catch {
    // Dropped on purpose: an unreadable tree answers null rather than failing a
    // listing, which is why every caller treats null as "nothing to report".
    return null;
  }
}

// The top-level directory of the repository's MAIN working tree. Every linked
// worktree of one repository reports the same path, which is what a caller
// needs to tell two conductors' sessions apart (umbel#65).
//
// `git worktree list --porcelain` names the main worktree first. Asking git for
// it is more faithful than deriving it: `--show-toplevel` would answer with the
// linked worktree the worker actually runs in, and the parent of
// `--git-common-dir` assumes the standard `.git` layout.
//
// null outside a git repository, and for a bare repository, which has no
// working tree to report.
export async function repoRoot(path: string): Promise<string | null> {
  const out = await gitOut(path, ['worktree', 'list', '--porcelain'], GIT_CALL_TIMEOUT_MS);
  if (out === null) return null;
  const lines = out.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('worktree ')) return null;
  if ((lines[1] ?? '').trim() === 'bare') return null;
  return first.slice('worktree '.length);
}

// The commit HEAD points at, or null in a repository with no commit yet.
// Recorded at spawn as the base a later status measures the worker's commits
// and diff against (umbel#153). Full object id, so a caller can compare it
// with the id git reports anywhere else.
export async function headCommit(path: string): Promise<string | null> {
  const out = await gitOut(path, ['rev-parse', 'HEAD'], GIT_CALL_TIMEOUT_MS);
  const sha = out?.trim() ?? '';
  return sha.length > 0 ? sha : null;
}

// What the worker's cwd holds now, measured from the HEAD spawn recorded.
// Reads only: umbel never writes in a worker's tree.
//
// null when the cwd is not a git repository (or git cannot answer). With no
// base, commits and the diff stat are empty: a cwd outside git at spawn, a
// session spawned before the base was recorded, or a repository whose first
// commit came later has nothing to measure the work against.
export async function workspace(cwd: string, baseHead: string | null): Promise<Workspace | null> {
  const deadline = Date.now() + GIT_CALL_TIMEOUT_MS;
  const remaining = (): number => Math.max(1, deadline - Date.now());

  const statusOut = await gitOut(cwd, ['status', '--porcelain=v2', '--branch'], remaining());
  if (statusOut === null) return null;
  const summary = parseStatusV2(statusOut);

  let commits: WorkspaceCommit[] = [];
  let diffStat: WorkspaceDiffStat = { files: 0, insertions: 0, deletions: 0 };
  if (baseHead !== null) {
    commits = parseLog(
      (await gitOut(cwd, ['log', '--format=%H%x09%s', `${baseHead}..HEAD`], remaining())) ?? '',
    );
    // diff-index, not diff: `git diff` refreshes the index as a side effect
    // (diff.autoRefreshIndex defaults to true) and writes it back even with
    // --no-optional-locks set, taking the very lock this read must leave alone.
    // The plumbing compares the working tree with the tree and writes nothing.
    diffStat = parseNumstat(
      (await gitOut(cwd, ['diff-index', '--numstat', baseHead], remaining())) ?? '',
    );
  }

  return { ...summary, baseHead, commits, diffStat };
}
