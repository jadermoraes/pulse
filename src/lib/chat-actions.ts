/**
 * Helpers for enriching chat tool-result frames on the client side.
 */

/**
 * Extract the first http(s) URL from a tool/action result object.
 *
 * The result from `runAction` / `playInJellyfin` is shaped:
 *   { ok: true, url: 'http://...' }
 * after passing through `scrub()`. We look at the top-level `url` field first
 * (the canonical Jellyfin deep-link location), then fall back to a shallow scan
 * of all top-level string values for anything that looks like an http(s) URL.
 *
 * Returns `null` for null/non-object results, results without a URL, or results
 * with a non-http(s) string in the `url` field (e.g. redacted / relative paths).
 */
export function extractResultUrl(result: unknown): string | null {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return null;

  const r = result as Record<string, unknown>;

  // Primary: explicit `url` field (runAction / Jellyfin deep-link shape)
  if (typeof r.url === 'string' && /^https?:\/\//i.test(r.url)) return r.url;

  // Fallback: scan other top-level string fields for an http(s) URL
  for (const [key, val] of Object.entries(r)) {
    if (key === 'url') continue; // already checked
    if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
  }

  return null;
}
