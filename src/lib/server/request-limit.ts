// In-memory sliding-window request-rate limiting. Resets on process restart (fine for burst/abuse
// protection). No DB writes on the hot path. Distinct from ratelimit.ts, which does failure-based
// login backoff.
const windows = new Map<string, number[]>();

export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now()
): { ok: boolean; retryAfter: number } {
  const arr = (windows.get(key) ?? []).filter((t) => t > now - windowMs);
  if (arr.length >= max) {
    windows.set(key, arr);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)) };
  }
  arr.push(now);
  windows.set(key, arr);
  return { ok: true, retryAfter: 0 };
}

/** Test-only: reset all in-memory state. */
export function __resetRequestLimitState(): void {
  windows.clear();
}
