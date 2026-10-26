export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  // Kill the command when it has not answered in this long. The bound is on the
  // wait for its output, not only on the process: a killed child can leave a
  // child of its own holding the pipe, and the caller must still answer
  // (umbel#98, umbel#153).
  timeoutMs?: number;
}

// Run a command, capture stdout. Throws on non-zero exit or a timeout.
// Side-effect at the edge.
export async function run(argv: readonly string[], opts?: RunOpts): Promise<string> {
  const proc = Bun.spawn([...argv], {
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const answered = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let output: [string, string, number];
    if (opts?.timeoutMs === undefined) {
      output = await answered;
    } else {
      const bound = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), opts.timeoutMs);
      });
      const raced = await Promise.race([answered, bound]);
      if (raced === undefined) {
        proc.kill('SIGKILL');
        throw new Error(
          `command did not answer within ${opts.timeoutMs / 1000}s: ${argv.join(' ')}`,
        );
      }
      output = raced;
    }
    const [out, err, code] = output;
    if (code !== 0) throw new Error(`command failed (exit ${code}): ${argv.join(' ')}\n${err}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
