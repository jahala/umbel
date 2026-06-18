# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue. Use GitHub's private advisory flow:

→ <https://github.com/jahala/umbel/security/advisories/new>

We'll acknowledge within 72 hours and coordinate disclosure with you.

## Supported versions

Only the latest minor release receives security updates. Older versions don't.

## Threat model

`umbel` is a developer tool that:

- Drives interactive agent CLIs (`claude`, `codex`, `gemini`) over `tmux`.
- Installs a single global Stop/AfterAgent hook script at `$UMBEL_STATE/hooks/stop.sh` (default `~/.umbel/`).
- Writes per-session metadata to `$UMBEL_STATE/sessions/<name>/`.
- Writes provider hook config inside the worker's `cwd` (`<cwd>/.codex/hooks.json`, `<cwd>/.gemini/settings.json`). Known hazard: if you have your own Codex/Gemini hooks config in that `cwd`, umbel will overwrite it on spawn (v4 plan: move provider config out of `cwd` via `CODEX_HOME`/equivalent).

It does **not** open network ports, accept inbound connections, or run as root. All side effects are local-fs + tmux + child processes. The trust boundary is the user's own shell.

## Automated security testing

- **Unit + integration tests** on every push (`bun test`, ~430 tests).
- **Type checking + lint** on every push (`bun run typecheck`, `bun run lint`).
- **Dependency Review** on PRs that touch `package.json` / `bun.lock` — gated on `moderate` severity (public repo only).
- **OpenSSF Scorecard** weekly, results uploaded to the Code scanning view.
- **Dependabot** weekly version updates for `npm` and `github-actions`.

## Reporting non-security bugs

Open a regular issue: <https://github.com/jahala/umbel/issues/new/choose>.
