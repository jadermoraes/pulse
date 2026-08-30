import type { DB } from '../db';
import { removeWatchlist } from './watchlist';
import { enqueueHouseholdRemoval } from './household-removals';
import { getStremioConnection, participantIds } from './household-stremio';
import { mirrorFavorite } from './jellyfin-favorite';

/**
 * Remove a title from the watchlist, household-aware. The single implementation behind both the
 * REST endpoint and the `watchlistRemove` chat tool — two surfaces with different removal
 * semantics would be worse than one.
 *
 * Household scope: the shared list belongs to the participants, so a participant's removal applies
 * to all of them and is queued for a Stremio tombstone. A non-participant (an invite with no
 * access to the household account) owns a private list; their removal is purely local and must
 * never touch anyone else's rows.
 */
export async function removeWatchlistEverywhere(
  db: DB, v: { actorId: number; tmdbId: number; mediaType: string }
): Promise<{ removed: boolean; household: boolean }> {
  const mediaType = v.mediaType === 'tv' ? 'tv' : 'movie';
  const conn = getStremioConnection(db);
  const participants = conn ? participantIds(db, conn) : [];
  const household = participants.includes(v.actorId);
  const targets = household ? participants : [v.actorId];

  const removed: Array<{ consumerId: number; jellyfinItemId: string | null }> = [];
  db.transaction(() => {
    for (const consumerId of targets) {
      const row = removeWatchlist(db, consumerId, v.tmdbId, mediaType);
      if (row) removed.push({ consumerId, jellyfinItemId: row.jellyfinItemId });
    }
    // Only queue a tombstone for a title the household actually held. Queuing one for a title
    // nobody had would push `removed: true` for an id the Library may never have seen.
    if (household && removed.length > 0) {
      enqueueHouseholdRemoval(db, { tmdbId: v.tmdbId, mediaType });
    }
  })();

  // Outside the transaction: these are network calls, and better-sqlite3 transactions are
  // synchronous. Per participant, because Jellyfin favourites are per-user.
  for (const r of removed) {
    if (r.jellyfinItemId) {
      await mirrorFavorite(db, r.consumerId, v.tmdbId, mediaType, false).catch(() => { /* best-effort */ });
    }
  }

  return { removed: removed.length > 0, household: household && removed.length > 0 };
}
