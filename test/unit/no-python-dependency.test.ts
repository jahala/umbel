import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The fakes and the build script may use only what this repository declares:
// bash, jq, bun and the usual coreutils. python3 is not one of them. On a Mac
// whose only python3 is the Xcode shim with the licence unaccepted it refuses
// to run: the fakes wrote no transcript and about fifteen tests failed
// (umbel#81).
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, '../..');
const TREES = ['test/fixtures', 'scripts'];

// A python command at a command position. Records that merely mention the
// word, as agy's denial message does ("e.g. python, sh, curl"), are not
// invocations and must not be flagged.
const PYTHON_COMMAND = /(?:^|[\s|&;(`$])python3?(?=$|[\s)"';&|])/;

function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

function filesUnder(tree: string): string[] {
  return [...new Bun.Glob('**/*').scanSync({ cwd: join(ROOT, tree) })].map((rel) =>
    join(tree, rel),
  );
}

describe('no file under test/fixtures or scripts invokes python', () => {
  test('finds none', () => {
    const offenders = TREES.flatMap((tree) =>
      filesUnder(tree).filter((rel) => {
        let source: string;
        try {
          source = readFileSync(join(ROOT, rel), 'utf8');
        } catch {
          return false; // the glob also lists directories
        }
        return PYTHON_COMMAND.test(withoutComments(source));
      }),
    );
    expect(offenders).toEqual([]);
  });

  test('the check finds an invocation where one is made', () => {
    // Guards the guard: the pattern must match the shape it forbids.
    expect(PYTHON_COMMAND.test('echo "$x" | python3 -c \'print(1)\'')).toBe(true);
    expect(PYTHON_COMMAND.test('  $(python -m json.tool)')).toBe(true);
    expect(PYTHON_COMMAND.test('(e.g. python, sh, curl)')).toBe(false);
  });
});
