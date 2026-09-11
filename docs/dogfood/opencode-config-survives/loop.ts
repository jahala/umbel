import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  'Ground truth, read before coding: the plugin install lives in src/adapters/hooks.ts installGlobalPlugin, called from src/operations/spawn.ts (around line 207) for providers with a globalPlugin, i.e. opencode. It resolves <XDG_CONFIG_HOME or ~/.config>/opencode/opencode.jsonc (env first, then process.env), reads it, calls the pure mergeOpencodePluginConfig(existing, pluginAbsPath) in src/core/providers/opencode.ts — JSON.parse in a try; a parse failure silently becomes {} and the file is then rewritten with only $schema and plugin, which is the defect — and writes the result unconditionally. Tests isolate the config dir with XDG_CONFIG_HOME under a tmp dir; copy the setup() in test/integration/opencode-provider.test.ts. The fake binary is test/fixtures/fake-opencode.sh, injected as opts.claudeBin on spawn() or UMBEL_CLAUDE_BIN on the CLI for every provider (docs mention UMBEL_OPENCODE_BIN but nothing in src reads it — do not rely on it). deps.exec.run(argv, {cwd, env}) in src/adapters/exec.ts runs a command and returns stdout, throwing on non-zero exit. The real `opencode models` prints one provider/model id per line (e.g. opencode/big-pickle) in about half a second. Typed errors live in src/core/errors.ts and are mapped to exit codes in src/faces/cli.ts (ProviderUnknownError and usage errors → 2, everything else → 1). biome checks src and test; the smoke suites under test/smoke are not part of bun run check.',
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'oc.parse',
    claim:
      '`mergeOpencodePluginConfig` reads `opencode.jsonc` as JSONC — `//` and `/* */` comments and trailing commas — and returns the file with the plugin path inserted and every other byte, comment and blank line preserved; a file that already lists the path comes back unchanged; a file that does not parse is reported as unparsable with its line and column, never replaced',
    evidence: 'test/unit/opencode-install.test.ts',
    needs: [],
    how: `The existing test file pins today's contract (null → create; other keys preserved; idempotent; valid JSON out). Extend it: add the failing cases first — the issue's Case A config (a provider block with a // comment inside it) must come back with the provider block, the comment and the blank lines intact and only the plugin entry added; a /* block */ comment and a trailing comma likewise; a file already listing the path comes back as the identical string; a file with a syntax error yields an unparsable result naming line and column. Then change the function's return type to a discriminated result so failure lives in the type, per S.U.P.E.R.: {kind: 'unchanged'} | {kind: 'write', content} | {kind: 'unparsable', line, column, reason} (null existing → write). Implement with jsonc-parser: bun add jsonc-parser (pure JS, no native modules), parse(text, errors, {allowTrailingComma: true}) to detect errors and read the plugin array, modify(text, ['plugin', -1], pluginAbsPath, {formattingOptions: {insertSpaces: true, tabSize: 2}}) + applyEdits to insert; when there is no plugin key, modify with path ['plugin'] and value [pluginAbsPath]. Update the callers that compile against the old string return (src/adapters/hooks.ts installGlobalPlugin) minimally so typecheck stays green — the adapter's refusal behaviour is the next check's job; here it may simply skip the write on 'unchanged' and throw on 'unparsable' through a typed error you add to src/core/errors.ts (OpencodeConfigUnparsableError with file, line, column, reason). Add jsonc-parser to CLAUDE.md's Stack line. ${GROUND}`,
  },
  {
    n: 2,
    id: 'oc.refuse',
    claim:
      '`installGlobalPlugin` on an `opencode.jsonc` that does not parse throws `OpencodeConfigUnparsableError` naming the file, line and column, leaves the file byte-identical, and `spawn` with the opencode provider rejects with it before any tmux session exists',
    evidence: 'test/integration/opencode-config-refused.test.ts',
    needs: ['oc.parse'],
    how: `Integration test against the real adapter with XDG_CONFIG_HOME and UMBEL_STATE under a tmp dir: write an opencode.jsonc with a syntax error (an unclosed object, a stray comma before a key), read its bytes, call installGlobalPlugin(provider.globalPlugin, env) → rejects with OpencodeConfigUnparsableError whose message contains the file path, the line and the column; read the bytes again → identical. Then spawn({provider: 'opencode', claudeBin: fake-opencode.sh, cwd, env, name}) → rejects with the same error, and tmux hasSession(name) is false (spawn must install the plugin before newSession — check the order in src/operations/spawn.ts and keep the refusal before any side effect on tmux or the session dir; if the session dir was already created, the test asserts it is gone or was never made — decide, say why in Tried). Map the error to exit 1 in src/faces/cli.ts with a one-line message: the file, line:column, and what to do (fix the file or move it aside). ${GROUND}`,
  },
  {
    n: 3,
    id: 'oc.idempotent',
    claim:
      'A second `spawn` with the opencode provider leaves `opencode.jsonc` byte-identical and does not write it at all (its mtime does not move); a first spawn on a commented config keeps every key and comment',
    evidence: 'test/integration/opencode-config-idempotent.test.ts',
    needs: ['oc.refuse'],
    how: `Integration test with the fake opencode binary and the tmp XDG_CONFIG_HOME: seed the issue's Case A config (provider block, // comment), spawn once → the file holds the plugin entry AND the provider block AND the comment (string containment on the original lines, not a re-parse); record bytes and mtime (utimes it a minute into the past first so a rewrite is detectable); spawn a second session → bytes identical and mtime unchanged. The adapter must not write on {kind: 'unchanged'} — the previous checks may already do this; if this test is green on arrival, find what is still churning (the fresh-file case must still write) and make the claim's mtime assertion the thing that was missing, or state in Tried that the RED phase was satisfied by the mtime assertion alone. Kill both sessions in afterEach. ${GROUND}`,
  },
  {
    n: 4,
    id: 'oc.model',
    claim:
      '`spawn` with the opencode provider and a model consults `opencode models` before launching; a model not listed rejects with `OpencodeModelUnknownError` naming the model and the ids that exist, with no session created; a listed model launches with `-m`',
    evidence: 'test/integration/opencode-model-check.test.ts',
    needs: ['oc.idempotent'],
    how: `Give test/fixtures/fake-opencode.sh a models verb: when $1 is models, print a fixed list (opencode/big-pickle, ollama/some-model, one per line) and exit 0 — before the banner. In spawn (src/operations/spawn.ts), for the opencode provider when opts.model is set: run [bin, 'models'] through d.exec.run with the launch's env and cwd, split lines, trim; if the model is absent throw OpencodeModelUnknownError(model, listed) from src/core/errors.ts — before installGlobalPlugin and before newSession, so nothing is created; a probe that itself fails (non-zero exit) is a spawn failure too, with the probe's stderr in the message (no silent pass-through: a probe umbel cannot run means umbel cannot vouch for the model). The listed case proceeds and the launch args carry -m <model> (assert through the fake's recorded argv or the pane). Map OpencodeModelUnknownError to exit 2 in src/faces/cli.ts with the model and the first few listed ids in the message. Put the probe behind the provider, not a string compare on the name: add an optional listModels(bin) → argv to the provider interface in src/core/providers/types.ts, implemented by opencode only. ${GROUND}`,
  },
  {
    n: 5,
    id: 'oc.docs',
    claim:
      "docs/cli-reference.md and `umbel help providers` (src/faces/mcp-help.ts) state the contract — `opencode.jsonc` is read as JSONC and edited in place preserving comments, an unparsable file refuses the spawn with exit 1, an unlisted model refuses the spawn with exit 2 — and CLAUDE.md's Stack line lists `jsonc-parser`",
    evidence: 'test/unit/opencode-config-doc.test.ts',
    needs: ['oc.model'],
    how: `A doc pin test: read the three files and assert the sentences the claim names (match on stable phrases: 'JSONC', 'preserv', 'exit 1', 'exit 2', 'jsonc-parser', 'opencode models'). RED first (the sentences are absent), then write them: docs/cli-reference.md's opencode notes near the UMBEL_OPENCODE_BIN row and the spawn --model row (state that the model is checked against opencode models and that an unlisted model is exit 2), the OpenCode block in src/faces/mcp-help.ts (replace the 'crash-safe, reversible' sentence with the actual contract: JSONC read, in-place edit preserving comments, refusal on an unparsable file, the model check), and CLAUDE.md's Stack line. Keep the docs short — one sentence per behaviour. ${GROUND}`,
  },
  {
    n: 6,
    id: 'oc.e2e',
    claim:
      'Through the CLI with the fake opencode binary: the reproduction from jahala/umbel#53 — a commented config with a provider block — survives `umbel spawn --provider opencode` with every key and comment intact; a broken config exits 1 naming the file, line and column and leaves the file byte-identical; an unlisted model exits 2 with no session; a listed one spawns',
    evidence: 'test/e2e/opencode-config.test.ts',
    needs: ['oc.docs'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/cli.test.ts: run the CLI entry (bun src/main.ts, or however cli.test.ts invokes it) with UMBEL_STATE, XDG_CONFIG_HOME under a tmp dir and UMBEL_CLAUDE_BIN=test/fixtures/fake-opencode.sh. (a) Seed the issue's exact Case A file (copy it from the issue text quoted in the loop page's narrative: provider ollama with a // comment inside), spawn --provider opencode --model ollama/some-model → exit 0; the file still contains the provider block and the comment line verbatim and the plugin entry. (b) A broken file → exit 1, stderr names the path and line:column, bytes identical. (c) --model nobody/nothing → exit 2, stderr names the model, umbel ls does not list the name. (d) --model opencode/big-pickle → exit 0 and the session exists. Kill every session in afterEach. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/opencode-config-survives.tend2.html',
  payload: '50a8f8de3550',
  title: "The user's opencode config survives a spawn",
  goal: "A spawn with the opencode provider reads the user's opencode.jsonc as JSONC (comments, trailing commas) and edits it in place preserving every byte it does not own; a file that does not parse refuses the spawn naming file, line and column and is left byte-identical; a file that already carries the plugin entry is not written at all; a --model opencode does not list refuses the spawn before a worker exists.",
  issue: 'jahala/umbel#53',
  sink: 'oc.e2e',
  checks,
};

export default spec;
