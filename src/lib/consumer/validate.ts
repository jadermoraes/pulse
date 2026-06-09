// Shared (client + server) validation for consumer onboarding credentials. Pure functions, no
// imports — safe to use in the join form for instant feedback AND in /api/app/join as the
// authoritative check (never trust the client). Each `validate*` returns an error STRING when
// invalid, or null when OK.

export const MIN_PW = 8;
export const MAX_PW = 128;
export const MAX_DISPLAY_NAME = 64;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

// Start/end alphanumeric; middle may include . _ - (no spaces — keeps the federated login
// unambiguous and avoids Jellyfin trim surprises). 3–32 chars overall.
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,30}[A-Za-z0-9]$/;

/** Normalize a free-text field the way the server will store/compare it. */
export function cleanText(s: unknown): string {
  return typeof s === 'string' ? s.trim() : '';
}

export function validateDisplayName(name: unknown): string | null {
  const n = cleanText(name);
  if (!n) return 'Please enter your name.';
  if (n.length > MAX_DISPLAY_NAME) return `Name must be at most ${MAX_DISPLAY_NAME} characters.`;
  return null;
}

export function validateUsername(username: unknown): string | null {
  const u = cleanText(username);
  if (!u) return 'Please choose a username.';
  if (u.length < USERNAME_MIN) return `Username must be at least ${USERNAME_MIN} characters.`;
  if (u.length > USERNAME_MAX) return `Username must be at most ${USERNAME_MAX} characters.`;
  if (!USERNAME_RE.test(u))
    return 'Use 3–32 letters, numbers, dot, underscore or hyphen (no spaces); start and end with a letter or number.';
  return null;
}

export function validatePassword(password: unknown, username?: unknown): string | null {
  const p = typeof password === 'string' ? password : '';
  if (p.length < MIN_PW) return `Password must be at least ${MIN_PW} characters.`;
  if (p.length > MAX_PW) return `Password must be at most ${MAX_PW} characters.`;
  if (!p.trim()) return 'Password cannot be only spaces.';
  if (cleanText(username) && p.toLowerCase() === cleanText(username).toLowerCase())
    return 'Password must be different from your username.';
  return null;
}

/** First error across all three fields, or null when everything is valid. */
export function validateOnboarding(input: {
  displayName?: unknown;
  username?: unknown;
  password?: unknown;
}): string | null {
  return (
    validateDisplayName(input.displayName) ??
    validateUsername(input.username) ??
    validatePassword(input.password, input.username)
  );
}
