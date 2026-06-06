import { describe, expect, test } from 'bun:test';
import { classifyNotification } from '../../src/core/notification.ts';

// classifyNotification reads the LAST line of the append-only events/notification
// JSONL and maps it to a needs-input reason. Verified facts (claude 2.1.167):
// notification_type ∈ {permission_prompt, idle_prompt, worker_permission_prompt,
// auth_success, elicitation_dialog, elicitation_complete, elicitation_response};
// the last three (auth_success + elicitation_complete/response) are informational,
// NOT a worker awaiting input.

function line(obj: object): string {
  return `${JSON.stringify(obj)}\n`;
}

describe('classifyNotification', () => {
  test('permission_prompt → permission', () => {
    const c = classifyNotification(
      line({ notification_type: 'permission_prompt', message: 'Claude needs your permission' }),
    );
    expect(c.reason).toBe('permission');
  });

  test('idle_prompt → idle (done-and-idle, not blocked)', () => {
    const c = classifyNotification(
      line({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }),
    );
    expect(c.reason).toBe('idle');
  });

  test('elicitation_dialog → question', () => {
    const c = classifyNotification(
      line({ notification_type: 'elicitation_dialog', message: 'Claude Code needs your input' }),
    );
    expect(c.reason).toBe('question');
  });

  test('auth_success → null (informational, NOT awaiting input)', () => {
    expect(
      classifyNotification(line({ notification_type: 'auth_success', message: 'login ok' })).reason,
    ).toBeNull();
  });

  test('elicitation_complete / elicitation_response → null', () => {
    expect(
      classifyNotification(line({ notification_type: 'elicitation_complete' })).reason,
    ).toBeNull();
    expect(
      classifyNotification(line({ notification_type: 'elicitation_response' })).reason,
    ).toBeNull();
  });

  test('claude worker_permission_prompt → permission + extracted tool', () => {
    const c = classifyNotification(
      line({
        notification_type: 'worker_permission_prompt',
        message: 'agent-7 needs permission for Bash',
      }),
    );
    expect(c.reason).toBe('permission');
    expect(c.tool).toBe('Bash');
  });

  test('codex PermissionRequest (tool_name, no notification_type) → permission + tool', () => {
    const c = classifyNotification(
      line({ hook_event_name: 'PermissionRequest', tool_name: 'shell' }),
    );
    expect(c.reason).toBe('permission');
    expect(c.tool).toBe('shell');
  });

  test('gemini ToolPermission → permission', () => {
    const c = classifyNotification(
      line({
        notification_type: 'ToolPermission',
        message: 'Tool run_shell_command requires execution',
      }),
    );
    expect(c.reason).toBe('permission');
  });

  test('opencode permission.updated line → permission + tool', () => {
    const c = classifyNotification(
      line({
        hook_event_name: 'permission.updated',
        notification_type: 'permission',
        tool_name: 'bash',
      }),
    );
    expect(c.reason).toBe('permission');
    expect(c.tool).toBe('bash');
  });

  test('classifies the LAST line (latest state wins)', () => {
    const content =
      line({ notification_type: 'permission_prompt' }) + line({ notification_type: 'idle_prompt' });
    expect(classifyNotification(content).reason).toBe('idle');
  });

  test('empty / malformed → null (never throws)', () => {
    expect(classifyNotification('').reason).toBeNull();
    expect(classifyNotification('not json\n').reason).toBeNull();
    expect(classifyNotification('   ').reason).toBeNull();
  });

  test('bare {ts} line (no-jq fallback) → permission (conservative surface)', () => {
    expect(classifyNotification(line({ ts: 123 })).reason).toBe('permission');
  });
});
