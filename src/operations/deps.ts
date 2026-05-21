import * as fsState from '../adapters/fs-state.ts';
import { watch } from '../adapters/fs-watch.ts';
import * as hooks from '../adapters/hooks.ts';
import * as jsonl from '../adapters/jsonl.ts';
import * as tmux from '../adapters/tmux.ts';

// ---------------------------------------------------------------------------
// Deps — default adapter wirings for operations
// ---------------------------------------------------------------------------

export const defaultDeps = {
  tmux,
  fs: fsState,
  hooks,
  jsonl,
  watch,
};

export type Deps = typeof defaultDeps;
