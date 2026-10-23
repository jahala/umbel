import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERB_HELP, VerbSchemas, verbHelpText } from '../../src/faces/verbs.ts';

const CLI = readFileSync(join(import.meta.dir, '../../src/faces/cli.ts'), 'utf8');

// The function whose body reads a verb's flags. status and ls share the listing
// filter, so listFilter is scanned for both.
const VERB_HANDLERS: Record<string, readonly string[]> = {
  spawn: ['verbSpawn'],
  send: ['verbSend'],
  wait: ['verbWait'],
  status: ['verbStatus', 'listFilter'],
  ls: ['verbLs', 'listFilter'],
  kill: ['verbKill'],
  prune: ['verbPrune'],
  attach: ['verbAttach'],
  read: ['verbRead'],
  actions: ['verbActions'],
  diff: ['verbDiff'],
  capture: ['verbCapture'],
  logs: ['verbLogs'],
  run: ['verbRun'],
  mcp: ['verbMcp'],
};

function functionBody(name: string): string {
  const start = CLI.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = ['\nfunction ', '\nasync function ']
    .map((needle) => CLI.indexOf(needle, start + 1))
    .filter((at) => at > start);
  const end = next.length > 0 ? Math.min(...next) : CLI.length;
  return CLI.slice(start, end);
}

// Every flag spelling a handler reads: the keys passed to flagStr/flagBool and
// to repeated.get.
function flagsRead(body: string): string[] {
  const names = new Set<string>();
  for (const call of body.matchAll(/flag(?:Str|Bool)\(flags,\s*([^)]*)\)/g)) {
    for (const literal of (call[1] ?? '').matchAll(/'([^']+)'/g)) {
      const name = literal[1];
      if (name !== undefined) names.add(name);
    }
  }
  for (const call of body.matchAll(/repeated\.get\('([^']+)'\)/g)) {
    const name = call[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

const kebab = (field: string): string => field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const spellingsOf = (verb: string): string[] =>
  (VERB_HELP[verb as keyof typeof VERB_HELP]?.flags ?? []).flatMap((row) => [
    (row.flag ?? `--${kebab(row.field ?? '')}`).replace(/^-+/, ''),
    ...(row.also ?? []).map((also) => also.replace(/^-+/, '')),
  ]);

describe('per-verb help', () => {
  test('every verb the CLI routes has a help page, and no others', () => {
    expect(Object.keys(VERB_HELP).sort()).toEqual(Object.keys(VerbSchemas).sort());
    expect(Object.keys(VERB_HANDLERS).sort()).toEqual(Object.keys(VerbSchemas).sort());
  });

  test('every flag a CLI handler reads appears in that verb help', () => {
    for (const [verb, handlers] of Object.entries(VERB_HANDLERS)) {
      const read = new Set(handlers.flatMap((handler) => flagsRead(functionBody(handler))));
      const listed = new Set(spellingsOf(verb));
      const missing = [...read].filter((flag) => !listed.has(flag));
      expect(missing).toEqual([]);
    }
  });

  test('every flag a verb help lists is read by that CLI handler', () => {
    for (const [verb, handlers] of Object.entries(VERB_HANDLERS)) {
      const read = new Set(handlers.flatMap((handler) => flagsRead(functionBody(handler))));
      const phantom = spellingsOf(verb).filter((flag) => !read.has(flag));
      expect(phantom).toEqual([]);
    }
  });

  test('every schema field is a flag, a positional or declared MCP-only', () => {
    for (const verb of Object.keys(VerbSchemas)) {
      const help = VERB_HELP[verb as keyof typeof VERB_HELP];
      const fields = new Set([
        ...help.flags.flatMap((row) => (row.field !== undefined ? [row.field] : [])),
        ...help.positionals.flatMap((row) => (row.field !== undefined ? [row.field] : [])),
        ...(help.mcpOnlyFields ?? []),
      ]);
      const schemaFields = Object.keys(VerbSchemas[verb as keyof typeof VerbSchemas].shape);
      expect(schemaFields.filter((field) => !fields.has(field))).toEqual([]);
      expect([...fields].filter((field) => !schemaFields.includes(field))).toEqual([]);
    }
  });

  test('the rendered help lists every flag and the usage line', () => {
    for (const verb of Object.keys(VERB_HELP)) {
      const help = VERB_HELP[verb as keyof typeof VERB_HELP];
      const text = verbHelpText(verb);
      expect(text).toBeDefined();
      expect(text).toContain(`umbel ${verb}`);
      expect(text).toContain(help.usage);
      for (const row of help.flags) {
        expect(text).toContain(row.flag ?? `--${kebab(row.field ?? '')}`);
      }
      for (const positional of help.positionals) {
        expect(text).toContain(positional.token);
      }
    }
  });

  test('an unknown verb has no help page', () => {
    expect(verbHelpText('bogus')).toBeUndefined();
  });
});
