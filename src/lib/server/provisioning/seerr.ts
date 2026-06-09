import { joinUrl, getJsonWithKey, sendJsonWithKey } from '../http';
import type { Connection } from '../connections';

// --- Endpoint constants (verify against live seerr; see Task 8 Step 4) -----------------
const EP_USER_LIST = '/api/v1/user';
const EP_IMPORT = '/api/v1/user/import-from-jellyfin';
const EP_USER = (id: number) => `/api/v1/user/${id}`;
const EP_USER_DELETE = (id: number) => `/api/v1/user/${id}`;
// Quota does NOT apply via PUT /user/{id} (that handler only reads username+permissions).
// It must go through the user-settings "main" endpoint, and only takes effect when the
// target user lacks MANAGE_USERS (true for consumers). Verified live against the fork.
const EP_USER_SETTINGS_MAIN = (id: number) => `/api/v1/user/${id}/settings/main`;

interface SeerrUser { id: number; jellyfinUserId?: string; username?: string; email?: string; }

async function getUser(conn: Connection, id: number): Promise<SeerrUser> {
  return (await getJsonWithKey(joinUrl(conn.baseUrl, EP_USER(id)), conn.secret)) as SeerrUser;
}

async function findByJellyfinId(conn: Connection, jellyfinUserId: string): Promise<number | null> {
  const data = await getJsonWithKey(
    joinUrl(conn.baseUrl, EP_USER_LIST, { take: 200 }), conn.secret
  );
  const results: SeerrUser[] = Array.isArray(data) ? data : (data?.results ?? []);
  const match = results.find((u) => u.jellyfinUserId === jellyfinUserId);
  return match ? match.id : null;
}

/**
 * Idempotent: ensure a seerr user imported from the given Jellyfin user exists, then apply
 * role permissions (bitmask) + the role's seerr quota. Returns the seerr user id.
 */
export async function ensureSeerrUserFromJellyfin(
  conn: Connection,
  jellyfinUserId: string,
  permissions: number,
  quota: { movie?: number; tv?: number }
): Promise<number> {
  let id = await findByJellyfinId(conn, jellyfinUserId);
  if (id == null) {
    const imported = await sendJsonWithKey(
      joinUrl(conn.baseUrl, EP_IMPORT), 'POST', conn.secret, { jellyfinUserIds: [jellyfinUserId] }
    );
    const list: SeerrUser[] = Array.isArray(imported) ? imported : (imported?.results ?? []);
    const match = list.find((u) => u.jellyfinUserId === jellyfinUserId) ?? list[0];
    // Some seerr versions return only counts; re-query as a fallback.
    id = match?.id ?? (await findByJellyfinId(conn, jellyfinUserId));
    if (id == null) throw new Error('seerr import did not produce a user for this Jellyfin id');
  }

  // Permissions go on the user record itself (PUT only reads username+permissions).
  await sendJsonWithKey(joinUrl(conn.baseUrl, EP_USER(id)), 'PUT', conn.secret, { permissions });

  // Quota is applied separately via settings/main; skip entirely when no quota is set.
  if (quota.movie != null || quota.tv != null) {
    // settings/main requires the username/email — fetch them from the user record.
    const u = await getUser(conn, id);
    const settings: Record<string, unknown> = { username: u.username, email: u.email };
    if (quota.movie != null) { settings.movieQuotaLimit = quota.movie; settings.movieQuotaDays = 7; }
    if (quota.tv != null) { settings.tvQuotaLimit = quota.tv; settings.tvQuotaDays = 7; }
    await sendJsonWithKey(joinUrl(conn.baseUrl, EP_USER_SETTINGS_MAIN(id)), 'POST', conn.secret, settings);
  }

  return id;
}

/** Best-effort delete (rollback) of a seerr user by id. */
export async function deleteSeerrUser(conn: Connection, id: number): Promise<void> {
  await sendJsonWithKey(joinUrl(conn.baseUrl, EP_USER_DELETE(id)), 'DELETE', conn.secret);
}
