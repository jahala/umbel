// umbel's side of the runner contract in jahala/plotplot (contracts/runner.md):
// the reasons `wait` returns and the exit code each one carries. A conductor
// classifies a finished wait by the reason in this table, so both repositories
// test against the same pinned fixture (test/fixtures/contracts/pins.json). A
// new reason lands in the contract first, then here (umbel#84).

export const WAIT_REASONS = [
  'stop',
  'file',
  'pattern',
  'provider-error',
  'idle',
  'timeout',
  'dead',
  'input',
  'aborted',
] as const;

export type WaitReason = (typeof WAIT_REASONS)[number];

export const WAIT_EXIT_CODES: Record<WaitReason, number> = {
  stop: 0,
  file: 0,
  pattern: 0,
  'provider-error': 122,
  idle: 123,
  timeout: 124,
  dead: 125,
  input: 126,
  aborted: 130,
};
