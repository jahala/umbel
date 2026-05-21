# rctrl core layer — implementation summary

## Files created

### Implementation (`src/core/`)

| File | LOC | Description |
|---|---|---|
| `errors.ts` | 65 | 8 typed Error subclasses, each with `name` override |
| `id.ts` | 20 | `generateSessionName` (base36, injectable RNG), `isValidSessionName` |
| `types.ts` | 112 | Zod schemas + inferred types: Session, WaitCondition, WorkflowSpec |
| `wait.ts` | 113 | `compile(WaitCondition) → CompiledWait`, `applyDefaultTimeout` |
| `workflow.ts` | 133 | `parseWorkflow`, `topoSort` (Kahn's algorithm), `substitute` |

**Total implementation: 443 LOC**

### Tests (`test/unit/`)

| File | LOC | Tests |
|---|---|---|
| `errors.test.ts` | 151 | 24 |
| `id.test.ts` | 105 | 20 |
| `types.test.ts` | 307 | 37 |
| `wait.test.ts` | 249 | 22 |
| `workflow.test.ts` | 239 | 25 |

**Total tests: 128 across 5 files**

## Acceptance criteria

- `bun test test/unit/` — 128 pass, 0 fail
- `bun run typecheck` — clean
- `bun run lint` — clean (biome)

## Deviations from spec

### `WakeSource` type (spec §4 decision)
Spec made a mid-task decision to make WakeSource symbolic. Implemented as:
```ts
type WakeSource =
  | { kind: 'stop-event'; session: string }
  | { kind: 'file'; path: string }
  | { kind: 'pattern'; session: string }
  | { kind: 'timer'; ms: number };
```
The `stop-event` wake source carries the session name; the operations layer resolves it to `sessions/<name>/events/stop`.

### `WaitCondition` type annotation
`WaitConditionBaseSchema` is typed as `z.ZodType<WaitCondition, z.ZodTypeDef, unknown>` (not the inferred type) to avoid branded `SessionName` inference conflicts at the `z.lazy` recursive boundary. Runtime validation is identical.

### `RctrlUsageError` constructor
Biome flagged the explicit `constructor(message: string) { super(message); }` as `noUselessConstructor` since `Error` already accepts a message. Removed — the class inherits the constructor from `Error` directly.

### `compile` — stop predicate path
The `evaluate` function for a `stop` condition checks `fileMtime('sessions/<session>/events/stop')`. This is a relative logical path, not an absolute filesystem path. The operations layer's `WaitContext.fileMtime` implementation resolves it against `$RCTRL_STATE`.
