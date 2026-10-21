// A command the worker's CLI left running in its pane.
//
// A worker can end its turn while a command it started runs on: one launched in
// the background, or a monitor it asked its tool to keep alive. The stop hook
// says the turn ended, not that the worktree is quiet (jahala/umbel#106).
//
// What counts is taken from the live process tree of a claude worker on this
// machine (recordings in test/fixtures/procs/):
//
//   bash launch.sh            the pane
//   └─ claude                 the worker's CLI
//      ├─ /bin/zsh -c <cmd>   a tool command's shell
//      │  └─ sleep 600        the command
//      ├─ bash hooks/stop.sh  a hook: a shell, but no -c
//      │  └─ ps               the hook's own work
//      ├─ node ... --mcp      an MCP server the CLI started
//      └─ caffeinate          the CLI's own helper
//
// A command counts when it runs under a shell the CLI started with `-c` (the
// form Claude Code uses for every tool command). The CLI's non-shell children
// and their subtrees (MCP servers, caffeinate) are its infrastructure. A hook is
// started as `bash <script>`, without -c, so the hook and what it runs are
// umbel's own plumbing. The rule is stated, not inferred: only the `-c` form is
// verified, so a provider that runs tool commands another way would report none.
//
// The listing is `ps -A -o pid=,ppid=,args=`. Quoting is lost by ps, so a path
// containing spaces is split; the command name stays right for everything else.

export interface RunningCommand {
  pid: number;
  command: string;
}

interface Proc {
  pid: number;
  ppid: number;
  argv: string[];
}

// Shells that take `-c <command>`.
const SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
  'tcsh',
  'csh',
]);

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

// The process's command line, named by its executable rather than the ps
// `comm` column: on macOS comm is truncated to 16 characters and can itself
// contain a space, which makes it unusable as a name.
function describe(p: Proc): string {
  const [argv0, ...rest] = p.argv;
  if (argv0 === undefined) return '?';
  const text = [baseName(argv0), ...rest].join(' ');
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

// `<shell> -c <command>`: the CLI asked a shell to run a command string. Hooks
// and the launch wrapper are shells too, but never with -c.
function isCommandShell(p: Proc): boolean {
  const argv0 = p.argv[0];
  if (argv0 === undefined || !SHELLS.has(baseName(argv0))) return false;
  return p.argv.slice(1).some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
}

function parse(output: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number.parseInt(m[1] ?? '', 10);
    const ppid = Number.parseInt(m[2] ?? '', 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const argv = (m[3] ?? '').split(/\s+/).filter((s) => s.length > 0);
    procs.push({ pid, ppid, argv });
  }
  return procs;
}

// Pure + total: never throws. panePid is the pane's own process (the launch
// wrapper); its children are the worker CLI. A pid with nothing under it, or a
// stale one, finds nothing.
export function runningCommands(psOutput: string, panePid: number): RunningCommand[] {
  const children = new Map<number, Proc[]>();
  for (const p of parse(psOutput)) {
    const list = children.get(p.ppid);
    if (list === undefined) children.set(p.ppid, [p]);
    else list.push(p);
  }

  const found: RunningCommand[] = [];
  const walk = (p: Proc, inToolShell: boolean): void => {
    const shell = isCommandShell(p);
    if (inToolShell && !shell) {
      found.push({ pid: p.pid, command: describe(p) });
      // Everything below is part of this command, not a command of its own.
      return;
    }
    for (const child of children.get(p.pid) ?? []) walk(child, inToolShell || shell);
  };

  for (const worker of children.get(panePid) ?? []) walk(worker, false);
  found.sort((a, b) => a.pid - b.pid);
  return found;
}
