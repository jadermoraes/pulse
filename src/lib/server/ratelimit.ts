const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface Entry {
  fails: number;
  firstAt: number;
  lockedUntil: number | null;
}

const store = new Map<string, Entry>();

function prune(): void {
  const now = Date.now();
  for (const [ip, entry] of store) {
    // Remove entries that are no longer locked and whose window has passed
    const windowExpired = now - entry.firstAt > WINDOW_MS;
    const lockExpired = entry.lockedUntil != null && entry.lockedUntil <= now;
    if ((entry.lockedUntil == null && windowExpired) || (lockExpired && windowExpired)) {
      store.delete(ip);
    }
  }
}

export function loginAllowed(ip: string): { allowed: boolean; retryAfterSec?: number } {
  prune();
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry) return { allowed: true };

  if (entry.lockedUntil != null && entry.lockedUntil > now) {
    const retryAfterSec = Math.ceil((entry.lockedUntil - now) / 1000);
    return { allowed: false, retryAfterSec };
  }

  // Lock expired or never set — window may have rolled over
  if (entry.lockedUntil != null && entry.lockedUntil <= now) {
    store.delete(ip);
    return { allowed: true };
  }

  // Within the window and not yet locked
  if (now - entry.firstAt <= WINDOW_MS && entry.fails >= MAX_FAILURES) {
    const lockedUntil = entry.firstAt + WINDOW_MS;
    store.set(ip, { ...entry, lockedUntil });
    const retryAfterSec = Math.ceil((lockedUntil - now) / 1000);
    return { allowed: false, retryAfterSec };
  }

  return { allowed: true };
}

export function recordLoginFailure(ip: string): void {
  prune();
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry) {
    store.set(ip, { fails: 1, firstAt: now, lockedUntil: null });
    return;
  }

  // If window has rolled over, reset counter
  if (now - entry.firstAt > WINDOW_MS && (entry.lockedUntil == null || entry.lockedUntil <= now)) {
    store.set(ip, { fails: 1, firstAt: now, lockedUntil: null });
    return;
  }

  const fails = entry.fails + 1;
  const lockedUntil = fails >= MAX_FAILURES ? entry.firstAt + WINDOW_MS : null;
  store.set(ip, { ...entry, fails, lockedUntil });
}

export function recordLoginSuccess(ip: string): void {
  store.delete(ip);
}

/** For tests only — reset all state. */
export function _resetStore(): void {
  store.clear();
}
