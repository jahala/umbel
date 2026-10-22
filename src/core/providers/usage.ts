import type { Usage } from './types.ts';

// Shared accumulation for providers whose transcript can report one turn in
// several records. Each provider adds what its format holds; the totals keep
// track of which fields appeared, so the returned Usage omits the rest. PURE.

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  hasCacheReadTokens: boolean;
  hasCacheWriteTokens: boolean;
}

export function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    hasInputTokens: false,
    hasOutputTokens: false,
    hasCacheReadTokens: false,
    hasCacheWriteTokens: false,
  };
}

export function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function addInputTokens(totals: UsageTotals, value: number | undefined): void {
  if (value === undefined) return;
  totals.inputTokens += value;
  totals.hasInputTokens = true;
}

export function addOutputTokens(totals: UsageTotals, value: number | undefined): void {
  if (value === undefined) return;
  totals.outputTokens += value;
  totals.hasOutputTokens = true;
}

export function addCacheReadTokens(totals: UsageTotals, value: number | undefined): void {
  if (value === undefined) return;
  totals.cacheReadTokens += value;
  totals.hasCacheReadTokens = true;
}

export function addCacheWriteTokens(totals: UsageTotals, value: number | undefined): void {
  if (value === undefined) return;
  totals.cacheWriteTokens += value;
  totals.hasCacheWriteTokens = true;
}

export function usageOf(totals: UsageTotals, model?: string): Usage | undefined {
  const hasUsage =
    totals.hasInputTokens ||
    totals.hasOutputTokens ||
    totals.hasCacheReadTokens ||
    totals.hasCacheWriteTokens;
  if (!hasUsage) return undefined;
  return {
    ...(totals.hasInputTokens ? { inputTokens: totals.inputTokens } : {}),
    ...(totals.hasOutputTokens ? { outputTokens: totals.outputTokens } : {}),
    ...(totals.hasCacheReadTokens ? { cacheReadTokens: totals.cacheReadTokens } : {}),
    ...(totals.hasCacheWriteTokens ? { cacheWriteTokens: totals.cacheWriteTokens } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
