import { run } from './exec.ts';

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
  let out: string;
  try {
    out = await run(['git', '-C', path, 'worktree', 'list', '--porcelain']);
  } catch {
    return null;
  }
  const lines = out.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('worktree ')) return null;
  if ((lines[1] ?? '').trim() === 'bare') return null;
  return first.slice('worktree '.length);
}
