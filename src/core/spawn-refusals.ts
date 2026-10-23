// The spawn refusals that carry an exit code of their own, umbel's side of the
// runner contract (jahala/plotplot contracts/fixtures/runner/spawn-refusals.jsonl,
// vendored and pinned in test/fixtures/contracts/). One home, so the test reads
// the table the CLI returns from.
export const SPAWN_REFUSALS = ['not-signed-in'] as const;
export type SpawnRefusal = (typeof SPAWN_REFUSALS)[number];

// A refused spawn's exit code, where it says more than failure. The runner
// contract reads this table (jahala/plotplot contracts/runner.md, "A spawn that
// needs a person is blocked, and says so by its exit code"): a CLI at its
// sign-in screen shares 126 with the wait reason `input`, since a person is
// needed and a retry meets the same screen. Every other spawn failure keeps its
// code (umbel#110).
export const SPAWN_EXIT_CODES: Record<SpawnRefusal, number> = {
  'not-signed-in': 126,
};
