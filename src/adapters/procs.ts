// List the machine's processes for the pane's process tree (core/procs.ts
// decides which of them are commands the worker left running).
//
// The listing is local and answers in milliseconds, but a wait that has already
// settled on stop must not be held by a child that never answers (umbel#98), so
// the call is bounded like every tmux call. The bound is on the wait for the
// output, not only on the process: a killed child can leave the pipe open.
export const PS_CALL_TIMEOUT_MS = 5_000;

export async function list(): Promise<string> {
  const proc = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,args='], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const answered = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), PS_CALL_TIMEOUT_MS);
  });
  try {
    const settled = await Promise.race([answered, bound]);
    if (settled === undefined) {
      proc.kill('SIGKILL');
      throw new Error(`ps did not answer within ${PS_CALL_TIMEOUT_MS / 1000}s`);
    }
    const [stdout, stderr, exitCode] = settled;
    if (exitCode !== 0) throw new Error(`ps failed (exit ${exitCode}): ${stderr.trim()}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
