// What a worker has done to its cwd, read from git's own output (umbel#153).
// Pure: adapters/git.ts runs the commands, these functions read their answers.

export interface WorkspaceCommit {
  hash: string;
  subject: string;
}

export interface WorkspaceDiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

// The branch, HEAD and tree state `git status` reports. Split out because it is
// the one part a read always has, even when there is no base to measure against.
export interface StatusSummary {
  // null when HEAD is detached.
  branch: string | null;
  // The commit HEAD points at, or null in a repository with no commit yet.
  head: string | null;
  // Tracked files with uncommitted changes right now.
  changedFiles: number;
  untrackedFiles: number;
}

export interface Workspace extends StatusSummary {
  // The HEAD spawn recorded, or null when the cwd was not a git repository or
  // had no commit at spawn.
  baseHead: string | null;
  // Commits made since spawn, newest first.
  commits: WorkspaceCommit[];
  // Tracked work since spawn: what was committed and what is still uncommitted.
  diffStat: WorkspaceDiffStat;
}

// `git status --porcelain=v2 --branch`. Header lines name the branch and HEAD;
// an entry line is one path: `1 ` ordinary, `2 ` renamed or copied, `u `
// unmerged, `? ` untracked. Ignored paths (`! `) are never requested.
export function parseStatusV2(out: string): StatusSummary {
  let branch: string | null = null;
  let head: string | null = null;
  let changedFiles = 0;
  let untrackedFiles = 0;

  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length);
      branch = name === '(detached)' ? null : name;
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length);
      head = oid === '(initial)' ? null : oid;
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      changedFiles += 1;
    } else if (line.startsWith('? ')) {
      untrackedFiles += 1;
    }
  }

  return { branch, head, changedFiles, untrackedFiles };
}

// `git log --format=%h%x09%s`: a short hash, a tab, the subject.
export function parseLog(out: string): WorkspaceCommit[] {
  const commits: WorkspaceCommit[] = [];
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) commits.push({ hash: line, subject: '' });
    else commits.push({ hash: line.slice(0, tab), subject: line.slice(tab + 1) });
  }
  return commits;
}

// `git diff --numstat`: additions, a tab, deletions, a tab, the path. A binary
// file prints `-` for both counts: it is a changed file with no line counts.
export function parseNumstat(out: string): WorkspaceDiffStat {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const [added, removed] = line.split('\t');
    files += 1;
    insertions += Number.parseInt(added ?? '', 10) || 0;
    deletions += Number.parseInt(removed ?? '', 10) || 0;
  }
  return { files, insertions, deletions };
}
