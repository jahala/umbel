// Run a command, capture stdout. Throws on non-zero exit. Side-effect at the edge.
export async function run(
  argv: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  const proc = Bun.spawn([...argv], {
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`command failed (exit ${code}): ${argv.join(' ')}\n${err}`);
  return out;
}
