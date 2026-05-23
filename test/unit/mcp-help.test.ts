import { describe, expect, test } from 'bun:test';
import { HELP_TOPICS, helpForTopic } from '../../src/faces/mcp-help.ts';

describe('helpForTopic', () => {
  test('no topic returns an index listing all topics', () => {
    const text = helpForTopic();
    expect(text).toContain('rctrl_help topics');
    for (const topic of HELP_TOPICS) {
      expect(text).toContain(topic);
    }
  });

  test('lifecycle topic contains verb contracts and the critical send→wait rule', () => {
    const text = helpForTopic('lifecycle');
    expect(text.length).toBeGreaterThan(500);
    expect(text).toContain('spawn');
    expect(text).toContain('rctrl_send');
    expect(text).toContain('rctrl_wait');
    expect(text).toContain('rctrl_read');
    expect(text).toContain('Pair every rctrl_send with a rctrl_wait');
  });

  test('workflow topic contains the YAML schema markers', () => {
    const text = helpForTopic('workflow');
    expect(text.length).toBeGreaterThan(500);
    // Drift guard — these terms also live in docs/workflows.md and the
    // WorkflowSpecSchema. Wholesale staleness would drop them.
    expect(text).toContain('workers:');
    expect(text).toContain('steps:');
    expect(text).toContain('needs:');
    expect(text).toContain('{{ steps.NAME.outputs.KEY }}');
    expect(text).toContain('rctrl run');
  });

  test('providers topic enumerates all three with stopEventName and hazards', () => {
    const text = helpForTopic('providers');
    expect(text.length).toBeGreaterThan(500);
    expect(text).toContain('claude');
    expect(text).toContain('codex');
    expect(text).toContain('gemini');
    expect(text).toContain('AfterAgent');
    expect(text).toContain('hooks.json');
    expect(text).toContain('settings.json');
    expect(text).toContain('OVERWRITES');
  });

  test('unknown topic returns an error string listing valid topics', () => {
    const text = helpForTopic('bogus');
    expect(text).toContain('Unknown');
    expect(text).toContain('bogus');
    for (const topic of HELP_TOPICS) {
      expect(text).toContain(topic);
    }
  });

  test('HELP_TOPICS is exactly the three topics we ship', () => {
    expect([...HELP_TOPICS].sort()).toEqual(['lifecycle', 'providers', 'workflow']);
  });
});
