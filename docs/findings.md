# rctrl — Open Question Findings

Resolution of `docs/architecture-v2.md` §13 open questions. Verified against Anthropic docs and Claude Code GitHub issues, May 2026.

## Q1: Stop hook semantics — **RESOLVED**

Stop fires **only at end-of-turn**, after response generation completes. Not mid-turn, not on tool waits, not on permission prompts.

Source: [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks).

**Implication:** safe as "agent done" signal. No spurious wakes.

## Q2: JSONL write ordering — **RESOLVED with caveat**

JSONL lines stream incrementally during generation. Assistant messages arrive as **multiple partial entries** without `stop_reason` set until response completes. Stop hook may fire before the final line is fully flushed.

Source: [What I Learned Parsing Claude Code's JSONL](https://medium.com/@ywian/what-i-learned-parsing-claude-codes-jsonl-session-logs-268248be0a2c).

**Implication:** `adapters/jsonl.ts` must:
1. Read JSONL after Stop fires.
2. Walk back from the end, joining consecutive assistant entries.
3. Only trust the last entry if it carries `stop_reason`.
4. If not, retry with backoff (50ms × up to 10 retries).

## Q3: `claude -p` permission defaults — **RESOLVED**

`claude -p` defaults to **read-only**: no Bash/Edit without `--allowedTools`. Default mode is `dontAsk` (no interactive prompts). Read-only builtins (`ls`, `cat`, `git status`, etc.) work without approval.

Source: [Configure permissions](https://code.claude.com/docs/en/permissions); [Print Mode & Automation](https://deepwiki.com/zebbern/claude-code-guide/3.2-print-mode-and-automation).

**Implication:** `rctrl -p` mirrors `claude -p` defaults. Pass `--allowedTools` and/or `--dangerously-skip-permissions` through unchanged.

## Q4: `--remote-control` — **ORTHOGONAL TO RCTRL**

`--remote-control` (`--rc`) is **cloud-based device sync**: connect to the same Claude Code session from another device via a session URL/QR. Subscription-billed on Team/Enterprise plans. Requires Claude Code v2.1.51+.

Source: [Remote Control docs](https://code.claude.com/docs/en/remote-control).

**Implication:** not a control API. rctrl and `--remote-control` are complementary, not overlapping. Mention in README; do not integrate in v1.

## Q5: `--worktree` and `--tmux` — **AVAILABLE BUT NOT USED**

Both built-in:
- `--worktree [name]`: creates a git worktree, scopes session to it.
- `--tmux`: wraps session in tmux (or iTerm2 native panes if available).

Source: [Power User Tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips).

**Decision:** **rctrl manages tmux directly** (not via `claude --tmux`). Reasons:
1. The iTerm2 fallback in `claude --tmux` makes behavior environment-dependent.
2. We need predictable session names (`rctrl-<name>`) for `send-keys` / `capture-pane`.
3. Direct control is simpler than working around `claude`'s tmux conventions.

Worktree management remains the user's responsibility (`git worktree add` before `rctrl spawn --cwd ...`). Future: rctrl could wrap `--worktree`. Out of v1 scope.

## Q6: Hook installation via `--settings` — **RESOLVED**

`--settings '<inline-json>'` works. Pass:
```json
{ "hooks": { "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/script" }] }] } }
```

Source: [Hooks guide](https://code.claude.com/docs/en/hooks-guide); [Settings overview](https://code.claude.com/docs/en/settings).

**Implication:** no need to write `.claude/settings.local.json` in the cwd. Cleaner, no collision risk.

## Q7: Multi-line prompts — **RESOLVED**

`tmux send-keys -l` loses newlines. Use `load-buffer` + `paste-buffer`:
```bash
echo "$PROMPT" | tmux load-buffer -b "rctrl-buf" -
tmux paste-buffer -p -d -b "rctrl-buf" -t "session"
tmux send-keys -t "session" Enter
```

`-p` = bracketed paste (handles terminals that interpret characters as commands), `-d` = delete buffer after paste.

Source: [GitHub Issue #43169](https://github.com/anthropics/claude-code/issues/43169).

**Implication:** `adapters/tmux.ts` exposes `sendText(name, text)` that auto-picks `paste-buffer` when `text.includes('\n')`, else `send-keys -l`.

## Q8: `--session-id` & JSONL path — **PARTIALLY RESOLVED**

- In `-p` mode: `--session-id <uuid>` controls JSONL filename. JSONL at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
- In **interactive mode** (which rctrl uses): `--session-id` is API/telemetry only. The CLI generates its own UUID for local persistence.
- CWD encoding: replace non-alphanumeric with `-`. Example: `/Users/you/code` → `-Users-you-code`.

Source: [Sessions docs](https://code.claude.com/docs/en/agent-sdk/sessions); [Issue #44607](https://github.com/anthropics/claude-code/issues/44607).

**Implication:** rctrl cannot pre-determine the interactive JSONL filename. Workaround:
1. Before spawn: snapshot `ls ~/.claude/projects/<encoded-cwd>/*.jsonl` → set A.
2. Spawn claude.
3. Watch the projects dir with chokidar for new `.jsonl` files appearing.
4. The new file (not in set A) is ours. Save path to `meta.json`.

This is implemented in `adapters/jsonl.ts:discoverSessionJsonl(cwd, sinceMs)`.

---

## Updates baked into v2.1 (in this doc + CLAUDE.md)

- JSONL frame merging required (Q2).
- JSONL discovery via dir snapshot diff (Q8).
- Multi-line auto-routing via `sendText` (Q7).
- Hook installation via inline `--settings` (Q6) — already in §6 of architecture-v2.
- rctrl manages tmux directly (Q5).
- `claude -p` default permissions mirrored (Q3).
- `--remote-control` documented as orthogonal (Q4).
