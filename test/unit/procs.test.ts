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
      { pid: 18123, command: 'sleep 600' },
    ]);
  });

  test('the Stop hook and its own work are not commands the worker left running', () => {
    expect(runningCommands(fixture('claude-stop-hook.ps'), PANE)).toEqual([
      { pid: 18123, command: 'sleep 600' },
    ]);
  });

  test('a pane with no process under it reports none', () => {
    expect(runningCommands(fixture('claude-background.ps'), 1)).toEqual([]);
  });
});
