# BLOCKED: c6 (e2e) cannot go RED on this tree without faking it

The RED gate needs `bun run check` to fail. On HEAD (a58f538) it can't fail honestly. The five sibling nodes (oc.parse, oc.refuse, oc.idempotent, oc.model, oc.docs) already shipped every behaviour this check drives through the CLI. A test of the claim passes.

## Evidence

`test/e2e/opencode-config.test.ts` runs `bun src/main.ts spawn --provider opencode` with `UMBEL_STATE` and `XDG_CONFIG_HOME` under a tmp dir and `UMBEL_CLAUDE_BIN=test/fixtures/fake-opencode.sh`. It has five cases:

1. The issue's Case A file, verbatim from jahala/umbel#53, with `--model ollama/some-model`. Expected: exit 0, every original line in order, the comment kept, the plugin appended.
2. A broken file. Expected: exit 1, stderr names `<path>:4:3`, the file is byte-identical, no session.
3. `--model nobody/nothing`. Expected: exit 2, stderr names the model, `umbel ls` doesn't list the session, the config is untouched.
4. `/* */` comments and trailing commas survive. A second spawn leaves the file byte-identical, and its mtime (backdated first) doesn't move.
5. `--model opencode/big-pickle`. Expected: exit 0 and the session exists.

- On HEAD, all 5 pass.
- Against the pre-loop source (e441f6f `src/` with the same test and fake), cases 1 to 4 fail. The config is wiped, nothing refuses, and the model isn't checked. Case 5 passes there too, which is expected because a listed model spawned before the loop as well.

So the test exercises the real behaviour. It is green because the work is done.

## Gaps probed and ruled out

- Tilde plugin entry. Case A lists `"~/.umbel/hooks/opencode-stop.ts"`. umbel compares it to the absolute path and appends that path instead of treating the tilde entry as already present. That is correct. The installed opencode 1.18's `resolvePluginSpec` only treats `file://`, `.`-prefixed and absolute specs as paths, so `~/…` is read as a package name and never expanded.
- `opencode.json` next to the `opencode.jsonc` umbel writes. opencode merges `config.json`, `opencode.json` and `opencode.jsonc` in that order, so the file umbel writes doesn't hide the user's file.

## What a fix needs

The conductor should skip or waive the RED phase for a sink node whose siblings already delivered its behaviour, and go straight to the verify/audit phase. The test file is ready for that.
