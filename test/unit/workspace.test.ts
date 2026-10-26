import { describe, expect, test } from 'bun:test';
import { parseLog, parseNumstat, parseStatusV2 } from '../../src/core/workspace.ts';

// The parsers behind `status`'s workspace section (jahala/umbel#153). They read
// git's own output formats, so the fixtures here are verbatim git output,
// including the shapes a worker's tree really produces: a rename, an unmerged
// path, an ignored file, a binary file, a detached HEAD and an unborn branch.

describe('parseStatusV2', () => {
  test('reads the branch, the HEAD and the changed and untracked counts', () => {
    const out = [
      '# branch.oid 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +1 -2',
      '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb b.txt',
      '2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 renamed.txt',
      'u UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb c.txt',
      '? new.txt',
      '? dir/',
      '! ignored.txt',
    ].join('\n');

    expect(parseStatusV2(out)).toEqual({
      branch: 'main',
      head: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
      changedFiles: 3,
      untrackedFiles: 2,
    });
  });

  test('a detached HEAD has no branch', () => {
    const out = ['# branch.oid 1a2b3c4', '# branch.head (detached)'].join('\n');
    expect(parseStatusV2(out)).toEqual({
      branch: null,
      head: '1a2b3c4',
      changedFiles: 0,
      untrackedFiles: 0,
    });
  });

  test('a repository with no commit yet has no HEAD', () => {
    const out = ['# branch.oid (initial)', '# branch.head main', '? first.txt'].join('\n');
    expect(parseStatusV2(out)).toEqual({
      branch: 'main',
      head: null,
      changedFiles: 0,
      untrackedFiles: 1,
    });
  });

  test('empty output is a clean, nameless tree rather than a crash', () => {
    expect(parseStatusV2('')).toEqual({
      branch: null,
      head: null,
      changedFiles: 0,
      untrackedFiles: 0,
    });
  });
});

describe('parseLog', () => {
  test('splits each commit into its short hash and subject', () => {
    expect(parseLog('abc1234\tfix the thing\ndef5678\tadd a test\n')).toEqual([
      { hash: 'abc1234', subject: 'fix the thing' },
      { hash: 'def5678', subject: 'add a test' },
    ]);
  });

  test('a subject that holds a tab stays whole', () => {
    expect(parseLog('abc1234\tcol1\tcol2\n')).toEqual([{ hash: 'abc1234', subject: 'col1\tcol2' }]);
  });

  test('an empty log is no commits', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('parseNumstat', () => {
  test('sums the per-file counts git prints', () => {
    expect(parseNumstat('1\t2\ta.txt\n3\t4\tb.txt\n')).toEqual({
      files: 2,
      insertions: 4,
      deletions: 6,
    });
  });

  test('a binary file counts as a file with no line counts', () => {
    expect(parseNumstat('1\t2\ta.txt\n-\t-\timage.png\n')).toEqual({
      files: 2,
      insertions: 1,
      deletions: 2,
    });
  });

  test('an empty diff stat has no files', () => {
    expect(parseNumstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});
