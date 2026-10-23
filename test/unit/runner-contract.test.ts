import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPAWN_EXIT_CODES, SPAWN_REFUSALS } from '../../src/core/spawn-refusals.ts';
import { WAIT_EXIT_CODES, WAIT_REASONS, type WaitReason } from '../../src/core/wait-reasons.ts';
import type { WaitResult } from '../../src/operations/wait.ts';

// umbel's side of the runner contract: jahala/plotplot contracts/runner.md. A
// conductor classifies a finished wait by its reason, so the reasons and exit
// codes umbel returns must be the ones the contract names. The fixture below is
// a verbatim copy pinned in test/fixtures/contracts/pins.json and read offline,
// because the test suite never fetches. A reason added on one side only is a
// seam change both repositories test (umbel#84).

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compile-time, checked by `bunx tsc --noEmit -p .`: `wait` cannot return a
// reason the contract lacks, and the contract cannot name one `wait` never
// returns.
const unionIsTheContractList: Assert<Same<WaitResult['reason'], WaitReason>> = true;

interface FixtureRow {
  reason: string;
  exitCode: number;
}

const rows: FixtureRow[] = readFileSync(
  join(import.meta.dir, '../fixtures/contracts/runner-reasons.jsonl'),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as FixtureRow);

describe('the runner contract (jahala/plotplot contracts/runner.md)', () => {
  test('the wait reason union is the contract list', () => {
    // The real check is the Assert above, which tsc runs; this keeps the
    // constant used at runtime as well.
    expect(unionIsTheContractList).toBe(true);
  });

  test('the fixture and the reason list hold the same reasons, once each', () => {
    const reasons = rows.map((row) => row.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons.sort()).toEqual([...WAIT_REASONS].sort());
  });

  test('each reason carries the exit code the contract names', () => {
    const codesFromFixture = Object.fromEntries(rows.map((row) => [row.reason, row.exitCode]));
    expect(codesFromFixture).toEqual(WAIT_EXIT_CODES);
  });
});

// The same contract's spawn half: a refusal with an exit code of its own.
describe('the runner contract: spawn refusals', () => {
  const refusals: FixtureRow[] = readFileSync(
    join(import.meta.dir, '../fixtures/contracts/spawn-refusals.jsonl'),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureRow);

  test('each refusal carries the exit code the contract names, and no other exists', () => {
    expect(refusals.map((row) => row.reason).sort()).toEqual([...SPAWN_REFUSALS].sort());
    expect(Object.fromEntries(refusals.map((row) => [row.reason, row.exitCode]))).toEqual(
      SPAWN_EXIT_CODES,
    );
  });
});
