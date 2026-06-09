// Resolve a Plex account from an auth token. Tiny helper used by the provisioning orchestrator.
//
// --- Endpoint constant (LIVE-VERIFY against plex.tv; see plan Task 20 Step 1) ---
// Verify the /api/v2/user response shape (id, email field names) against a real account.
const PLEX_USER = 'https://plex.tv/api/v2/user';

export interface PlexAccount {
  id: string;
  email: string;
}

/** GET the Plex account behind an auth token → { id, email }. */
export async function plexAccountFromToken(token: string): Promise<PlexAccount> {
  if (process.env.PULSE_PROVISION_FAKE === '1') return { id: 'px-fake', email: 'x@y' };
  const res = await fetch(PLEX_USER, {
    headers: { Accept: 'application/json', 'X-Plex-Token': token }
  });
  if (!res.ok) throw new Error(`Plex account → HTTP ${res.status}`);
  const data = await res.json();
  return { id: String(data.id), email: String(data.email) };
}
