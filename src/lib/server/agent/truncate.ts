/**
 * Guardrail against oversized tool results bleeding tokens.
 *
 * A single unbounded tool result (e.g. Radarr GET /api/v3/release returning ~300k chars of
 * release JSON) gets persisted into ai_messages and re-sent to the provider on EVERY later
 * call — every step of every turn — multiplying its token cost for the life of the
 * conversation. Cap results at the source: anything over the budget is reduced to a prefix
 * the model can still act on, plus an explicit marker telling it the result was cut and to
 * query narrower if it needs more.
 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 24_000;

function maxCharsFromEnv(): number {
  const n = Number(process.env.PULSE_TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOOL_RESULT_CHARS;
}

interface TruncatedArray {
  truncated: true;
  shownItems: number;
  totalItems: number;
  note: string;
  items: unknown[];
}

interface TruncatedPreview {
  truncated: true;
  note: string;
  preview: string;
}

function arrayNote(shown: number, total: number, maxChars: number): string {
  return `Result truncated to protect the context window: showing ${shown} of ${total} items ` +
    `(limit ${maxChars} chars). If you need entries not shown, re-query with narrower filters or paging.`;
}

/** Last-resort shape when no structural cut applies: a raw JSON prefix, shrunk until it fits. */
function previewFallback(json: string, maxChars: number): TruncatedPreview {
  const note = `Result truncated to protect the context window: raw JSON was ${json.length} chars ` +
    `(limit ${maxChars}). Re-query with narrower filters if you need more.`;
  let keep = Math.max(100, maxChars - note.length - 100);
  let out: TruncatedPreview = { truncated: true, note, preview: json.slice(0, keep) };
  // JSON-escaping can inflate the preview past the budget; halve until it fits.
  while (JSON.stringify(out).length > maxChars && keep > 100) {
    keep = Math.floor(keep / 2);
    out = { ...out, preview: json.slice(0, keep) };
  }
  return out;
}

function truncateArray(arr: unknown[], maxChars: number): TruncatedArray | TruncatedPreview {
  const overhead = 400; // wrapper keys + note + separators
  const budget = maxChars - overhead;
  let used = 0;
  const items: unknown[] = [];
  for (const item of arr) {
    const len = (JSON.stringify(item)?.length ?? 4) + 1;
    if (used + len > budget) break;
    used += len;
    items.push(item);
  }
  if (items.length === 0) return previewFallback(JSON.stringify(arr) ?? '[]', maxChars);
  return {
    truncated: true,
    shownItems: items.length,
    totalItems: arr.length,
    note: arrayNote(items.length, arr.length, maxChars),
    items
  };
}

/**
 * Cap a tool result at `maxChars` of JSON. Small results pass through untouched (same
 * reference). Oversized ones are cut structurally where possible:
 *  - array → prefix of items + truncation marker
 *  - object with a dominant array field (the {status,data} apiRead shape) → that field truncated,
 *    the rest of the object preserved
 *  - string → prefix + marker
 *  - anything else → raw JSON preview + marker
 */
export function truncateToolResult(value: unknown, maxChars = maxCharsFromEnv()): unknown {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { return value; }
  if (json == null || json.length <= maxChars) return value;

  if (typeof value === 'string') {
    const marker = ` … [truncated: ${value.length} chars total, limit ${maxChars}]`;
    return value.slice(0, Math.max(0, maxChars - marker.length)) + marker;
  }

  if (Array.isArray(value)) return truncateArray(value, maxChars);

  if (value && typeof value === 'object') {
    // Find the largest array field — the usual payload carrier (apiRead's `data`, widget lists).
    let bestKey: string | null = null;
    let bestLen = 0;
    for (const [k, v] of Object.entries(value)) {
      if (!Array.isArray(v)) continue;
      const len = JSON.stringify(v)?.length ?? 0;
      if (len > bestLen) { bestKey = k; bestLen = len; }
    }
    if (bestKey) {
      const restLen = json.length - bestLen;
      const budget = maxChars - restLen;
      if (budget > 500) {
        const copy = {
          ...(value as Record<string, unknown>),
          [bestKey]: truncateArray((value as Record<string, unknown>)[bestKey] as unknown[], budget)
        };
        if ((JSON.stringify(copy)?.length ?? Infinity) <= maxChars) return copy;
      }
    }
  }

  return previewFallback(json, maxChars);
}
