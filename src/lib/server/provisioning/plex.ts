// Plex OAuth PIN link flow + library share ("Wizarr trick").
//
// --- Endpoint constants (LIVE-VERIFY against plex.tv before real use; see plan Task 18 Step 5) ---
// Verify: PIN create/poll bodies, the X-Plex-Client-Identifier requirement, the auth-app URL
// format, and the shared_servers invite payload field names (invited_email vs invitedEmail,
// library_section_ids). Only these four constants / field names should change if Plex differs.
const PLEX_PINS = 'https://plex.tv/api/v2/pins';
const PLEX_PIN = (id: number) => `https://plex.tv/api/v2/pins/${id}`;
const PLEX_AUTH_APP = 'https://app.plex.tv/auth#?';
// Library-share uses the LEGACY v1 endpoint, which accepts an email directly (the v2
// /api/v2/shared_servers requires a numeric invitedId, not an email). Authed with the
// OWNER's X-Plex-Token. Payload shape verified against python-plexapi inviteFriend.
const PLEX_SERVER_SHARED_SERVERS = (machineId: string) =>
  `https://plex.tv/api/servers/${machineId}/shared_servers`;

// Product/client headers Plex expects on every call.
const PLEX_PRODUCT = 'Pulse';
const PLEX_VERSION = '1.0';

function plexHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Version': PLEX_VERSION
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

export interface PlexPin {
  id: number;
  code: string;
  authUrl: string;
}

export async function createPlexPin(clientId: string): Promise<PlexPin> {
  if (process.env.PULSE_PROVISION_FAKE === '1') {
    return {
      id: 1,
      code: 'FAKE',
      authUrl: `${PLEX_AUTH_APP}clientID=${encodeURIComponent(clientId)}&code=FAKE`
    };
  }
  const res = await fetch(PLEX_PINS, {
    method: 'POST',
    headers: {
      ...plexHeaders(),
      'X-Plex-Client-Identifier': clientId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ strong: true })
  });
  if (!res.ok) throw new Error(`Plex pin → HTTP ${res.status}`);
  const data = await res.json();
  const authUrl = `${PLEX_AUTH_APP}clientID=${encodeURIComponent(clientId)}&code=${encodeURIComponent(data.code)}`;
  return { id: data.id, code: data.code, authUrl };
}

/** Returns the authToken once the user authorizes the PIN, or null while still pending. */
export async function pollPlexPin(id: number, clientId: string): Promise<string | null> {
  if (process.env.PULSE_PROVISION_FAKE === '1') return 'plex-fake-tok';
  const res = await fetch(PLEX_PIN(id), {
    headers: { ...plexHeaders(), 'X-Plex-Client-Identifier': clientId }
  });
  if (!res.ok) throw new Error(`Plex pin poll → HTTP ${res.status}`);
  const data = await res.json();
  return data.authToken ? String(data.authToken) : null;
}

/**
 * Invite a Plex account (by email) to the owner's shared libraries — the "Wizarr trick".
 * Uses the legacy v1 `POST /api/servers/{machineId}/shared_servers` endpoint, authed with the
 * OWNER's X-Plex-Token. Payload shape matches python-plexapi `inviteFriend`:
 *   { server_id, shared_server: { library_section_ids, invited_email }, sharing_settings }.
 */
export async function sharePlexLibraries(
  ownerToken: string,
  machineId: string,
  librarySectionIds: number[],
  invitedEmail: string
): Promise<void> {
  if (process.env.PULSE_PROVISION_FAKE === '1') return;
  const res = await fetch(PLEX_SERVER_SHARED_SERVERS(machineId), {
    method: 'POST',
    headers: { ...plexHeaders(ownerToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server_id: machineId,
      shared_server: {
        library_section_ids: librarySectionIds,
        invited_email: invitedEmail
      },
      sharing_settings: {}
    })
  });
  if (!res.ok) throw new Error(`Plex share → HTTP ${res.status}`);
}
