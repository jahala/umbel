import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runningCommands } from '../../src/core/procs.ts';

// ps recordings from a real claude worker on this machine (see each fixture's
// header). Pane 16555 is the launch wrapper and 16579 is claude.
const PANE = 16555;

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, '..', 'fixtures', 'procs', name), 'utf8');
}

describe('runningCommands', () => {
  test('an idle worker has none: MCP servers and caffeinate are not commands', () => {
    expect(runningCommands(fixture('claude-idle.ps'), PANE)).toEqual([]);
  });

  test('a background sleep is named, and the shell that ran it is not', () => {
    expect(runningCommands(fixture('claude-background.ps'), PANE)).toEqual([
      { pid: 18123, command: 'sleep' },
    ]);
  });

  // Arguments can carry a token, and the conductor stores what status says, so
  // a command is named by its executable alone.
  test('a command is named without its arguments', () => {
    const ps = `${PANE} 1 bash launch.sh\n2 ${PANE} claude\n3 2 /bin/zsh -c curl\n4 3 /usr/bin/curl -H Authorization:secret https://x\n`;
    expect(runningCommands(ps, PANE)).toEqual([{ pid: 4, command: 'curl' }]);
  });

  // A loop of shell builtins runs with no child process of its own; the tool
  // shell still running is the command.
  test('a tool shell running only builtins is reported as the shell', () => {
    const ps = `${PANE} 1 bash launch.sh\n2 ${PANE} claude\n3 2 /bin/zsh -c while true; do :; done\n`;
    expect(runningCommands(ps, PANE)).toEqual([{ pid: 3, command: 'zsh' }]);
  });

  test('the Stop hook and its own work are not commands the worker left running', () => {
    expect(runningCommands(fixture('claude-stop-hook.ps'), PANE)).toEqual([
      { pid: 18123, command: 'sleep' },
    ]);
  });

  test('a pane with no process under it reports none', () => {
    expect(runningCommands(fixture('claude-background.ps'), 1)).toEqual([]);
  });
});
