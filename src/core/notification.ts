// Classify a worker's latest needs-input notification.
//
// events/notification is an append-only JSONL file (one line per Notification /
// PermissionRequest hook fire — see NOTIFY_HOOK_SCRIPT and the opencode plugin).
// The LATEST line is the current state. This pure function maps it to a reason
// the orchestrator can branch on, so `needsInput:true` is no longer ambiguous
// between "blocked on a permission prompt" and "done and idling".

export type NeedsInputReason = 'permission' | 'idle' | 'question';

export interface NotificationClassification {
  // null = the latest notification is informational (auth_success, elicitation
  // completion) or absent/malformed — the worker is NOT awaiting input.
  reason: NeedsInputReason | null;
  // Best-effort: the pending tool. Reliable from a structured tool_name (Codex
  // PermissionRequest, OpenCode); parsed from Claude's worker_permission_prompt
  // message. NOT available for Claude's MAIN permission_prompt — its hook message
  // is the fixed "Claude needs your permission" with no tool field (verified
  // against claude 2.1.167). Absent when unknown.
  tool?: string;
  message?: string;
}

// notification_type values that are informational, not a worker awaiting input.
const NON_BLOCKING: ReadonlySet<string> = new Set([
  'auth_success',
  'elicitation_complete',
  'elicitation_response',
]);

// Pure + total: never throws; returns { reason: null } for empty/malformed input.
export function classifyNotification(jsonlContent: string): NotificationClassification {
  const lines = jsonlContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return { reason: null };

  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(last);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { reason: null };
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return { reason: null };
  }

  const type = typeof obj.notification_type === 'string' ? obj.notification_type : undefined;
  const message = typeof obj.message === 'string' ? obj.message : undefined;
  const tool = deriveTool(obj, message);

  if (type !== undefined && NON_BLOCKING.has(type)) return { reason: null };
  if (type === 'idle_prompt') {
    return { reason: 'idle', ...(message !== undefined ? { message } : {}) };
  }
  if (type === 'elicitation_dialog') {
    return { reason: 'question', ...(message !== undefined ? { message } : {}) };
  }

  // Everything else that reached the notification hook is the worker awaiting a
  // decision: permission_prompt, worker_permission_prompt, gemini ToolPermission,
  // codex PermissionRequest (tool_name, no type), opencode permission — or an
  // unrecognized event, which we surface conservatively rather than hide.
  return {
    reason: 'permission',
    ...(tool !== undefined ? { tool } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

function deriveTool(obj: Record<string, unknown>, message: string | undefined): string | undefined {
  // Codex PermissionRequest + OpenCode carry a structured tool name.
  if (typeof obj.tool_name === 'string' && obj.tool_name.length > 0) return obj.tool_name;
  // Claude's subagent prompt embeds it: "<agentId> needs permission for <tool>".
  if (message !== undefined) {
    const m = message.match(/needs permission for (\S+)/);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}
