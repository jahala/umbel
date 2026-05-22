# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue. Use GitHub's private advisory flow:

→ <https://github.com/jahala/rctrl/security/advisories/new>

We'll acknowledge within 72 hours and coordinate disclosure with you.

## Supported versions

Only the latest minor release receives security updates. Older versions don't.

## Threat model

`rctrl` is a developer tool that:

- Drives interactive agent CLIs (`claude`, `codex`, `gemini`) over `tmux`.
- Installs a single global Stop/AfterAgent hook script at `$RCTRL_STATE/hooks/stop.sh` (default `~/.rctrl/`).
- Writes per-session metadata to `$RCTRL_STATE/sessions/<name>/`.
- Writes provider hook config inside the worker's `cwd` (`<cwd>/.codex/hooks.json`, `<cwd>/.gemini/settings.json`). See `docs/audit-C.md` §V1 for the known overwrite hazard and the v4 plan to move these out of `cwd`.

It does **not** open network ports, accept inbound connections, or run as root. All side effects are local-fs + tmux + child processes. The trust boundary is the user's own shell.

## Automated security testing

- **Unit + integration tests** on every push (`bun test`, ~430 tests).
- **Type checking + lint** on every push (`bun run typecheck`, `bun run lint`).
- **Dependency Review** on PRs that touch `package.json` / `bun.lock` — gated on `moderate` severity (public repo only).
- **OpenSSF Scorecard** weekly, results uploaded to the Code scanning view.
- **Dependabot** weekly version updates for `npm` and `github-actions`.

## Reporting non-security bugs

Open a regular issue: <https://github.com/jahala/rctrl/issues/new/choose>.
