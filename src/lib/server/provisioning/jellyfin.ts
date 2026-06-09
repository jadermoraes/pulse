import { joinUrl } from '../http';
import type { Connection } from '../connections';

// --- Endpoint constants (verify against the live Jellyfin server; see Task 7 Step 5) ----
const EP_USERS = '/Users';
const EP_USER_NEW = '/Users/New';
const EP_POLICY = (id: string) => `/Users/${id}/Policy`;
const EP_PASSWORD = (id: string) => `/Users/${id}/Password`;
const EP_AUTH = '/Users/AuthenticateByName';
const EP_USER = (id: string) => `/Users/${id}`;
const EP_USER_DELETE = (id: string) => `/Users/${id}`;


const EMBY_AUTH =
  'MediaBrowser Client="Pulse", Device="Pulse", DeviceId="pulse", Version="1.0"';

function adminHeaders(conn: Connection): Record<string, string> {
  return {
    'X-Emby-Token': conn.secret ?? '',
    'X-Emby-Authorization': EMBY_AUTH,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

async function jfGet(conn: Connection, path: string): Promise<any> {
  const res = await fetch(joinUrl(conn.baseUrl, path), { headers: adminHeaders(conn) });
  if (!res.ok) throw new Error(`Jellyfin GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function jfSend(conn: Connection, method: 'POST', path: string, body: unknown): Promise<any> {
  const res = await fetch(joinUrl(conn.baseUrl, path), {
    method, headers: adminHeaders(conn), body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Jellyfin ${method} ${path} → HTTP ${res.status}`);
  try { return await res.json(); } catch { return {}; }
}

/** Validate username/password against Jellyfin. Returns { id } or null on auth failure. */
export async function authenticateJellyfin(
  conn: Connection, username: string, password: string
): Promise<{ id: string } | null> {
  // Test hook (mirrors PULSE_AGENT_FAKE): deterministic federated login with no live server.
  // The id matches what the fake provisioner stores ('jf-' + username). A password of
  // 'rejectme' simulates an auth rejection.
  if (process.env.PULSE_PROVISION_FAKE === '1') {
    return password === 'rejectme' ? null : { id: 'jf-' + username };
  }
  const res = await fetch(joinUrl(conn.baseUrl, EP_AUTH), {
    method: 'POST',
    headers: { 'X-Emby-Authorization': EMBY_AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Pw: password })
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Jellyfin auth → HTTP ${res.status}`);
  const data = await res.json();
  const id = data?.User?.Id;
  return id ? { id: String(id) } : null;
}

/**
 * Is `username` already taken on Jellyfin? Used at onboarding to reject a duplicate up-front —
 * otherwise `ensureJellyfinUser` would silently ATTACH the new invitee to the existing account
 * (and their chosen password wouldn't match it, so login would fail). Case-insensitive.
 */
export async function jellyfinUsernameTaken(conn: Connection, username: string): Promise<boolean> {
  // Test hook (mirrors ensureJellyfinUser): 'taken' is reported as already-existing.
  if (process.env.PULSE_PROVISION_FAKE === '1') return username.toLowerCase() === 'taken';
  const users: Array<{ Name: string }> = await jfGet(conn, EP_USERS);
  return users.some((u) => u.Name?.toLowerCase() === username.toLowerCase());
}

/**
 * Idempotent: ensure a Jellyfin user named `username` exists with `password` and library access.
 * Returns the Jellyfin user id. Safe to re-run (re-running an invite must not duplicate users).
 */
export async function ensureJellyfinUser(
  conn: Connection, username: string, password: string
): Promise<string> {
  const users: Array<{ Id: string; Name: string }> = await jfGet(conn, EP_USERS);
  const existing = users.find((u) => u.Name?.toLowerCase() === username.toLowerCase());

  let id: string;
  // Jellyfin 10.11 requires the COMPLETE UserPolicy object on POST /Users/{id}/Policy —
  // a partial body 400s. So we take the server's full existing policy (from the create
  // response, or by fetching the user) and merge only the fields we need onto it.
  let basePolicy: Record<string, unknown> | undefined;
  if (existing) {
    id = existing.Id;
  } else {
    const created = await jfSend(conn, 'POST', EP_USER_NEW, { Name: username, Password: password });
    id = String(created?.Id ?? '');
    if (!id) throw new Error('Jellyfin user creation returned no id');
    if (created?.Policy && typeof created.Policy === 'object') {
      basePolicy = created.Policy as Record<string, unknown>;
    }
  }

  // Obtain the full server-side policy if we don't already have it (existing user, or a
  // create response without an embedded .Policy).
  if (!basePolicy) {
    const user = await jfGet(conn, EP_USER(id));
    if (user?.Policy && typeof user.Policy === 'object') {
      basePolicy = user.Policy as Record<string, unknown>;
    }
  }

  // Grant a baseline access policy (all libraries; not admin). Preserve every field the
  // server returned and override only the three we care about, then POST the full object.
  const mergedPolicy = {
    ...(basePolicy ?? {}),
    EnableAllFolders: true,
    IsAdministrator: false,
    IsDisabled: false
  };
  await jfSend(conn, 'POST', EP_POLICY(id), mergedPolicy);

  return id;
}

/**
 * Admin-set a user's password (recovery flow). Jellyfin 10.11: clear then set, both with the
 * admin token. ⚠ VERIFY against the live server — some builds accept a single POST
 * { CurrentPw:'', NewPw }. This clears (ResetPassword:true) then sets, which works broadly.
 */
export async function setJellyfinPassword(conn: Connection, id: string, newPassword: string): Promise<void> {
  if (process.env.PULSE_PROVISION_FAKE === '1') return; // hermetic test hook
  await jfSend(conn, 'POST', EP_PASSWORD(id), { Id: id, ResetPassword: true });
  await jfSend(conn, 'POST', EP_PASSWORD(id), { Id: id, CurrentPw: '', NewPw: newPassword });
}

/** Best-effort delete (rollback). A 404 (already gone) is treated as success. */
export async function deleteJellyfinUser(conn: Connection, id: string): Promise<void> {
  const res = await fetch(joinUrl(conn.baseUrl, EP_USER_DELETE(id)), {
    method: 'DELETE', headers: adminHeaders(conn)
  });
  if (!res.ok && res.status !== 404) throw new Error(`Jellyfin delete user → HTTP ${res.status}`);
}
