import type { Connection } from '../connections';
import type { DB } from '../db';
import { getConsumer } from '../identity/consumers';
import { listConnections } from '../connections';
import { markOnServer } from './watchlist';

function jfUrl(conn: Connection, path: string, query: Record<string, string> = {}): string {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + path);
  u.searchParams.set('api_key', conn.secret ?? '');
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

/** Resolve a tmdbId to a Jellyfin item id, or null. Best-effort (never throws). */
export async function resolveJellyfinItemId(conn: Connection, tmdbId: number): Promise<string | null> {
  try {
    const url = jfUrl(conn, '/Items', {
      Recursive: 'true', IncludeItemTypes: 'Movie,Series',
      AnyProviderIdEquals: `tmdb.${tmdbId}`, Limit: '1'
    });
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    const item = (d.Items ?? [])[0];
    return item?.Id ?? null;
  } catch { return null; }
}

/** POST (favorite) / DELETE (unfavorite) the item for a Jellyfin user. Returns success. */
export async function setFavorite(conn: Connection, jellyfinUserId: string, itemId: string, on: boolean): Promise<boolean> {
  try {
    const res = await fetch(jfUrl(conn, `/Users/${jellyfinUserId}/FavoriteItems/${itemId}`), {
      method: on ? 'POST' : 'DELETE'
    });
    return res.ok;
  } catch { return false; }
}

/**
 * Best-effort mirror of a watchlist title into the consumer's Jellyfin Favorites.
 * Resolves the item id; on success favorites/unfavorites it and (when favoriting) records the
 * item id on the watchlist row via markOnServer. Returns the resolved item id, or null.
 */
export async function mirrorFavorite(
  db: DB, consumerId: number, tmdbId: number, mediaType: string, on: boolean
): Promise<string | null> {
  const consumer = getConsumer(db, consumerId);
  if (!consumer?.jellyfinUserId) return null;
  const jf = listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled);
  if (!jf) return null;
  const itemId = await resolveJellyfinItemId(jf, tmdbId);
  if (!itemId) return null;
  const ok = await setFavorite(jf, consumer.jellyfinUserId, itemId, on);
  if (ok && on) markOnServer(db, consumerId, tmdbId, mediaType, itemId);
  return ok ? itemId : null;
}
