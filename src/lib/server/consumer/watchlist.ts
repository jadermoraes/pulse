import type { DB } from '../db';

export interface WatchlistRow {
  id: number; consumerId: number; tmdbId: number; mediaType: string; title: string;
  onServer: boolean; notifyOnAvailable: boolean; jellyfinItemId: string | null; addedAt: number;
}

function rowOf(r: any): WatchlistRow {
  return {
    id: r.id, consumerId: r.consumer_id, tmdbId: r.tmdb_id, mediaType: r.media_type, title: r.title,
    onServer: !!r.on_server, notifyOnAvailable: !!r.notify_on_available,
    jellyfinItemId: r.jellyfin_item_id ?? null, addedAt: r.added_at
  };
}

export function addWatchlist(db: DB, w: {
  consumerId: number; tmdbId: number; mediaType: string; title: string; onServer: boolean; notifyOnAvailable: boolean;
}): void {
  db.prepare(
    `INSERT INTO consumer_watchlist(consumer_id,tmdb_id,media_type,title,on_server,notify_on_available,added_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(consumer_id,tmdb_id,media_type) DO UPDATE SET
       title=excluded.title, on_server=excluded.on_server, notify_on_available=excluded.notify_on_available`
  ).run(w.consumerId, w.tmdbId, w.mediaType, w.title, w.onServer ? 1 : 0, w.notifyOnAvailable ? 1 : 0, Date.now());
}

/**
 * Insert a title the viewer saved in a SPOKE (Stremio), never touching a row pulse already owns.
 *
 * Deliberately not `addWatchlist`: that one is an upsert whose DO UPDATE sets
 * `on_server=excluded.on_server`, so importing a title pulse already has would reset an
 * `on_server=1` row back to 0 — and the availability poller would then notify the viewer a
 * second time for a title they were already told about. The import direction can be driven by a
 * transient upstream blip (an id that failed to resolve looks "unknown" for one cycle), so it
 * must be structurally incapable of clobbering local state: ON CONFLICT DO NOTHING.
 *
 * `notify_on_available` is 0 by design. A title the viewer saved in Stremio is not a notify
 * subscription they asked pulse for; on a first link this loop can see a hundred of them, and
 * notify=1 would fire a push AND a Telegram DM AND a Jellyfin favourite for every one of them.
 */
export function importWatchlist(db: DB, w: {
  consumerId: number; tmdbId: number; mediaType: string; title: string; onServer: boolean;
}): void {
  db.prepare(
    `INSERT INTO consumer_watchlist(consumer_id,tmdb_id,media_type,title,on_server,notify_on_available,added_at)
     VALUES (?,?,?,?,?,0,?)
     ON CONFLICT(consumer_id,tmdb_id,media_type) DO NOTHING`
  ).run(w.consumerId, w.tmdbId, w.mediaType, w.title, w.onServer ? 1 : 0, Date.now());
}

export function listWatchlist(db: DB, consumerId: number): WatchlistRow[] {
  return (db.prepare('SELECT * FROM consumer_watchlist WHERE consumer_id=? ORDER BY added_at DESC')
    .all(consumerId) as any[]).map(rowOf);
}

export function removeWatchlist(db: DB, consumerId: number, tmdbId: number, mediaType: string): WatchlistRow | null {
  const row = db.prepare('SELECT * FROM consumer_watchlist WHERE consumer_id=? AND tmdb_id=? AND media_type=?')
    .get(consumerId, tmdbId, mediaType) as any;
  if (!row) return null;
  db.prepare('DELETE FROM consumer_watchlist WHERE id=?').run(row.id);
  return rowOf(row);
}

export function markOnServer(db: DB, consumerId: number, tmdbId: number, mediaType: string, jellyfinItemId: string | null): void {
  db.prepare('UPDATE consumer_watchlist SET on_server=1, jellyfin_item_id=? WHERE consumer_id=? AND tmdb_id=? AND media_type=?')
    .run(jellyfinItemId, consumerId, tmdbId, mediaType);
}

/** Distinct (tmdbId, mediaType) pairs that at least one consumer wants a notify for and aren't on-server yet. */
export function listPendingNotify(db: DB): Array<{ tmdbId: number; mediaType: string }> {
  return (db.prepare(
    'SELECT DISTINCT tmdb_id, media_type FROM consumer_watchlist WHERE notify_on_available=1 AND on_server=0'
  ).all() as any[]).map((r) => ({ tmdbId: r.tmdb_id, mediaType: r.media_type }));
}

/** Consumers who want a notify for this title and haven't been marked on-server yet. */
export function consumersAwaiting(db: DB, tmdbId: number, mediaType: string): WatchlistRow[] {
  return (db.prepare(
    'SELECT * FROM consumer_watchlist WHERE tmdb_id=? AND media_type=? AND notify_on_available=1 AND on_server=0'
  ).all(tmdbId, mediaType) as any[]).map(rowOf);
}
