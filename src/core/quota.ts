// ---------------------------------------------------------------------------
// quota — subscription rate-limit usage, parsed from claude's statusLine payload
// ---------------------------------------------------------------------------
//
// A worker that runs into its subscription limit is alive, has not fired stop,
// and blocks on a dialog — indistinguishable from a worker that is merely
// thinking until the wait deadline. Knowing the usage BEFORE dispatch lets a
// caller re-cast the work to another provider instead of losing it.
//
// The numbers come from claude's statusLine JSON (`rate_limits`), not from
// scraping the pane: the pane line is presentational and changes between
// releases, which is exactly how the startup-dialog matcher rotted. Claude
// documents the shape as `.rate_limits.five_hour.used_percentage`.
//
// `rate_limits` is present only while the API reports it, so absence is the
// normal case and means "no limit pressure reported", not an error.

export interface Quota {
  // Percent of the 5-hour session limit consumed, when reported.
  fiveHourPct?: number;
  // Percent of the 7-day limit consumed, when reported.
  sevenDayPct?: number;
  // ISO timestamp the soonest reported window resets, when reported.
  resetsAt?: string;
}

function windowOf(value: unknown): { pct?: number; resetsAt?: string } | null {
  if (value === null || typeof value !== 'object') return null;
  const w = value as Record<string, unknown>;
  const pct = typeof w.used_percentage === 'number' ? w.used_percentage : undefined;
  const resetsAt = typeof w.resets_at === 'string' ? w.resets_at : undefined;
  if (pct === undefined && resetsAt === undefined) return null;
  return { ...(pct !== undefined ? { pct } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

// Pure and total: any malformed or limit-free payload yields null rather than
// throwing, because this runs on every status call.
export function parseQuota(content: string): Quota | null {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const limits = (payload as Record<string, unknown>).rate_limits;
  if (limits === null || typeof limits !== 'object') return null;

  const l = limits as Record<string, unknown>;
  const fiveHour = windowOf(l.five_hour);
  const sevenDay = windowOf(l.seven_day);
  if (fiveHour === null && sevenDay === null) return null;

  // Report the sooner reset — it is the one that will actually stop the worker.
  const resets = [fiveHour?.resetsAt, sevenDay?.resetsAt].filter(
    (r): r is string => r !== undefined,
  );
  resets.sort();

  return {
    ...(fiveHour?.pct !== undefined ? { fiveHourPct: fiveHour.pct } : {}),
    ...(sevenDay?.pct !== undefined ? { sevenDayPct: sevenDay.pct } : {}),
    ...(resets[0] !== undefined ? { resetsAt: resets[0] } : {}),
  };
}
