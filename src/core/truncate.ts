// ---------------------------------------------------------------------------
// truncateAssistantText — smart truncation for umbel_read output (pure)
// ---------------------------------------------------------------------------
//
// Purpose: the orchestrator's context burn is dominated by reading worker
// responses. For long responses this function returns a smaller view, either
// by extracting a named markdown section, taking a head/tail window, or
// applying a sensible default (head + elision marker + tail).
//
// All token counts are APPROXIMATE — uses chars/4 (cheap, no encoder
// dependency, ±20% accurate enough for budget decisions). Cuts are snapped
// to line boundaries to avoid mid-line truncation.
//
// Pure. Total. Never throws.

const CHARS_PER_TOKEN_APPROX = 4;
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_HEAD_TAIL_TOKENS = 800;

export interface TruncateOpts {
  head?: number; // first N (approx) tokens, snapped to nearest preceding newline
  tail?: number; // last N (approx) tokens, snapped to next newline after start
  section?: string; // markdown heading (e.g. "## Findings"); empty string if not found
  full?: boolean; // bypass all truncation; return text unchanged
}

export function truncateAssistantText(text: string, opts?: TruncateOpts): string {
  const o = opts ?? {};
  if (o.full === true) return text;

  if (o.section !== undefined) {
    return extractMarkdownSection(text, o.section);
  }

  const approxTokens = approxTokenCount(text);

  // No explicit window — smart default. Long enough to bite, short enough to
  // not annoy callers with surprise truncation on small responses.
  if (o.head === undefined && o.tail === undefined) {
    if (approxTokens <= DEFAULT_MAX_TOKENS) return text;
    return assembleHeadTail(text, DEFAULT_HEAD_TAIL_TOKENS, DEFAULT_HEAD_TAIL_TOKENS, approxTokens);
  }

  if (o.head !== undefined && o.tail !== undefined) {
    return assembleHeadTail(text, o.head, o.tail, approxTokens);
  }
  if (o.head !== undefined) {
    return takeHead(text, o.head);
  }
  // tail is set (the only remaining case)
  return takeTail(text, o.tail ?? 0);
}

function approxTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_APPROX);
}

function takeHead(text: string, tokens: number): string {
  const maxChars = Math.max(0, tokens) * CHARS_PER_TOKEN_APPROX;
  if (text.length <= maxChars) return text;
  // Prefer cutting at the nearest preceding newline.
  const cut = text.lastIndexOf('\n', maxChars);
  return cut > 0 ? text.slice(0, cut) : text.slice(0, maxChars);
}

function takeTail(text: string, tokens: number): string {
  const maxChars = Math.max(0, tokens) * CHARS_PER_TOKEN_APPROX;
  if (text.length <= maxChars) return text;
  const startApprox = text.length - maxChars;
  // Snap forward to the next newline so we don't start mid-line.
  const cut = text.indexOf('\n', startApprox);
  return cut > 0 ? text.slice(cut + 1) : text.slice(startApprox);
}

function assembleHeadTail(
  text: string,
  headTokens: number,
  tailTokens: number,
  totalTokens: number,
): string {
  const head = takeHead(text, headTokens);
  const tail = takeTail(text, tailTokens);
  const elidedTokens = Math.max(0, totalTokens - headTokens - tailTokens);
  return `${head}\n\n... [~${elidedTokens} tokens elided, call umbel_read with full=true to see all] ...\n\n${tail}`;
}

function extractMarkdownSection(text: string, heading: string): string {
  const target = heading.trim();
  if (target.length === 0) return '';

  const lines = text.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === target) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return '';

  // Heading depth = number of leading '#' chars in the target heading
  const headingMatch = target.match(/^(#+)\s/);
  const level = headingMatch !== null ? (headingMatch[1]?.length ?? 0) : 0;
  if (level === 0) {
    // target wasn't a markdown heading — just return the single matched line
    return lines[startIdx] ?? '';
  }

  const result: string[] = [lines[startIdx] ?? ''];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^(#+)\s/);
    if (m !== null && (m[1]?.length ?? 0) <= level) break;
    result.push(line);
  }
  return result.join('\n');
}
