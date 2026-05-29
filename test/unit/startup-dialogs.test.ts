import { describe, expect, test } from 'bun:test';
import { nextStartupDialog, type StartupDialog } from '../../src/core/startup-dialogs.ts';

const CODEX_DIALOGS: readonly StartupDialog[] = [
  { match: /trust the contents of this directory/i, keys: ['Enter'] },
  { match: /hooks need review/i, keys: ['Down', 'Enter'] },
];

describe('nextStartupDialog', () => {
  test('returns index of first matching, not-yet-fired dialog', () => {
    const pane = 'Do you trust the contents of this directory?\n1. Yes, continue';
    expect(nextStartupDialog(pane, CODEX_DIALOGS, new Set())).toBe(0);
  });

  test('skips an already-fired dialog even if it still matches the pane', () => {
    const pane = 'Do you trust the contents of this directory?';
    expect(nextStartupDialog(pane, CODEX_DIALOGS, new Set([0]))).toBeNull();
  });

  test('matches the second dialog once it appears', () => {
    const pane = 'Hooks need review\n1. Review hooks\n2. Trust all and continue';
    expect(nextStartupDialog(pane, CODEX_DIALOGS, new Set([0]))).toBe(1);
  });

  test('returns null when no dialog matches (e.g. main UI)', () => {
    const pane = '>_ OpenAI Codex (v0.133.0)\nImplement {feature}';
    expect(nextStartupDialog(pane, CODEX_DIALOGS, new Set())).toBeNull();
  });

  test('returns null for empty dialog list', () => {
    expect(nextStartupDialog('anything', [], new Set())).toBeNull();
  });

  test('returns the lowest not-yet-fired index when multiple match', () => {
    // Contrived pane containing both markers; index 0 not fired → returns 0.
    const pane = 'trust the contents of this directory ... hooks need review';
    expect(nextStartupDialog(pane, CODEX_DIALOGS, new Set())).toBe(0);
    // index 0 fired → returns 1.
    expect(nextStartupDialog(pane, CODEX_DIALOGS, new Set([0]))).toBe(1);
  });
});
