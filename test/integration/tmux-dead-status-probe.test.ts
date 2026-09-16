/**
 * PROBE, not a test of umbel: prints what this machine's tmux reports for a
 * pane whose process exited under remain-on-exit, so the CI log shows why
 * `#{pane_dead_status}` is empty on the ubuntu runner (jahala/umbel#89).
 */
import { test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function sh(argv: string[], env: Record<string, string>): Promise<string> {
  const p = Bun.spawn(argv, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  await p.exited;
  return `${out.trim()}${err.trim() ? ` [stderr: ${err.trim()}]` : ''}`;
}

test('probe: dead-pane formats on this tmux', async () => {
  const sock = join(await mkdtemp(join(tmpdir(), 'umbel-probe-')), 'sock');
  const t = (args: string[]) => sh(['tmux', '-S', sock, ...args], {});
  console.log('PROBE tmux -V:', await sh(['tmux', '-V'], {}));
  console.log('PROBE uname:', await sh(['uname', '-a'], {}));
  // A: umbel's shape — global option in the same invocation, then new-session
  console.log(
    'PROBE A new:',
    await t([
      'set-option',
      '-g',
      'remain-on-exit',
      'on',
      ';',
      'new-session',
      '-d',
      '-s',
      'a',
      '--',
      'sh',
      '-c',
      'exit 3',
    ]),
  );
  await Bun.sleep(1500);
  console.log(
    'PROBE A list-panes -s:',
    await t([
      'list-panes',
      '-s',
      '-t',
      'a',
      '-F',
      'dead=#{pane_dead} status=[#{pane_dead_status}] signal=[#{pane_dead_signal}] pid=#{pane_pid} cmd=#{pane_current_command}',
    ]),
  );
  console.log(
    'PROBE A display:',
    await t([
      'display-message',
      '-p',
      '-t',
      'a',
      'dead=#{pane_dead} status=[#{pane_dead_status}] signal=[#{pane_dead_signal}]',
    ]),
  );
  console.log('PROBE A show remain-on-exit:', await t(['show-options', '-g', 'remain-on-exit']));
  console.log(
    'PROBE A show -w remain-on-exit:',
    await t(['show-options', '-w', '-t', 'a', 'remain-on-exit']),
  );
  // B: window option set with -w after new-session, process exits later
  console.log(
    'PROBE B new:',
    await t(['new-session', '-d', '-s', 'b', '--', 'sh', '-c', 'sleep 1; exit 42']),
  );
  console.log('PROBE B setw:', await t(['set-option', '-w', '-t', 'b', 'remain-on-exit', 'on']));
  await Bun.sleep(2500);
  console.log(
    'PROBE B list-panes -s:',
    await t([
      'list-panes',
      '-s',
      '-t',
      'b',
      '-F',
      'dead=#{pane_dead} status=[#{pane_dead_status}] signal=[#{pane_dead_signal}]',
    ]),
  );
  // C: signal death
  console.log(
    'PROBE C new:',
    await t(['new-session', '-d', '-s', 'c', '--', 'sh', '-c', 'kill -TERM $$']),
  );
  await Bun.sleep(1500);
  console.log(
    'PROBE C list-panes -s:',
    await t([
      'list-panes',
      '-s',
      '-t',
      'c',
      '-F',
      'dead=#{pane_dead} status=[#{pane_dead_status}] signal=[#{pane_dead_signal}]',
    ]),
  );
  console.log('PROBE list-sessions:', await t(['list-sessions']));
  await t(['kill-server']);
});
