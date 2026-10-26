// Pure: builds a JSON string and touches nothing. It lives in core because the
// claude provider composes it into its launch spec, and core may not import
// from adapters (umbel#151).

export function buildSettingsJson(opts: {
  hookScriptPath: string;
  notifyScriptPath?: string;
  bindScriptPath?: string;
  allowedTools?: string;
  permissionMode?: string;
  unattended?: boolean;
  statusLineScriptPath?: string;
  // claude's UserPromptSubmit hook: touches events/turn-start when a submitted
  // prompt begins a turn (see TURN_START_HOOK_SCRIPT).
  turnStartScriptPath?: string;
}): string {
  const hooksBlock: Record<string, unknown> = {
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: opts.hookScriptPath,
          },
        ],
      },
    ],
  };

  // SessionStart binds the worker's own session id before the first turn, so a
  // CLI the worker starts later cannot pass its own stop off as the worker's
  // (umbel#118).
  if (opts.bindScriptPath !== undefined) {
    hooksBlock.SessionStart = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: `${opts.bindScriptPath} rebind` }],
      },
    ];
  }

  if (opts.turnStartScriptPath !== undefined) {
    // No matcher: UserPromptSubmit has no tool to match on.
    hooksBlock.UserPromptSubmit = [
      { hooks: [{ type: 'command', command: opts.turnStartScriptPath }] },
    ];
  }

  // Notification hook: fired when Claude is BLOCKED waiting on the user — a tool
  // permission prompt or an idle input wait. Lets a waiter return 'input'
  // instead of hanging to the timeout. Both matchers point at the same script.
  if (opts.notifyScriptPath !== undefined) {
    hooksBlock.Notification = [
      {
        matcher: 'permission_prompt',
        hooks: [{ type: 'command', command: opts.notifyScriptPath }],
      },
      {
        matcher: 'idle_prompt',
        hooks: [{ type: 'command', command: opts.notifyScriptPath }],
      },
    ];
  }

  const settings: Record<string, unknown> = {
    hooks: hooksBlock,
  };

  if (opts.statusLineScriptPath !== undefined) {
    settings.statusLine = { type: 'command', command: opts.statusLineScriptPath };
  }

  // Delivered through --settings rather than --dangerously-skip-permissions:
  // same effect, but it reuses the config channel umbel already owns and skips
  // that flag's separate --allow-dangerously-skip-permissions gate. An explicit
  // permissionMode still wins — the caller asked for a specific posture.
  const defaultMode =
    opts.permissionMode ?? (opts.unattended === true ? 'bypassPermissions' : undefined);

  if (opts.allowedTools !== undefined || defaultMode !== undefined) {
    const permissions: Record<string, unknown> = {};
    if (opts.allowedTools !== undefined) {
      permissions.allow = opts.allowedTools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (defaultMode !== undefined) {
      permissions.defaultMode = defaultMode;
    }
    settings.permissions = permissions;
  }

  return JSON.stringify(settings);
}
