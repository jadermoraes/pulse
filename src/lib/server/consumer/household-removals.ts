import type { DB } from '../db';

const SPOKE = 'stremio';

export interface HouseholdRemoval {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  imdbId: string | null;
  removedAt: number;
}

/**
 * Queue a title a participant removed in pulse, so the next poll can tombstone it in Stremio.
 *
 * The imdb id is resolved HERE, not at push time: once the watchlist rows are gone this queue row
 * is the only place the tmdb -> imdb mapping survives, and re-deriving it later would need Seerr.
 * A row that cannot be resolved is still worth keeping — it suppresses the re-import by tmdb id —
 * but it can never be pushed, so the drain drops it rather than retrying forever.
 */
export function enqueueHouseholdRemoval(
  db: DB, v: { tmdbId: number; mediaType: string }
): void {
  const mediaType = v.mediaType === 'tv' ? 'tv' : 'movie';
  // Resolve exactly the way `imdbForTmdb` (consumer/stremio-sync.ts) does — same cache, same key,
  // no `found` filter — because these two lookups must agree about which imdb id belongs to a
  // tmdb id. A row reached BY tmdb_id always carries a real pairing: either Cinemeta resolved it
  // (found=1), or Seerr backfilled tmdb_id onto a found=0 row, and that backfilled id is the one
  // pulse pushed into the Library. A pure Cinemeta negative has tmdb_id = NULL and so cannot match
  // this query at all. Filtering on found=1 would drop exactly the Seerr-backfilled case and make
  // the removal silently unpushable.
  const cached = db.prepare(
    `SELECT imdb_id FROM imdb_meta_cache WHERE tmdb_id = ? AND media_type = ?`
  ).get(v.tmdbId, mediaType === 'tv' ? 'series' : 'movie') as { imdb_id?: string } | undefined;

  db.prepare(
    `INSERT INTO household_removals(spoke,tmdb_id,media_type,imdb_id,removed_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(spoke,tmdb_id,media_type) DO UPDATE SET
       imdb_id = excluded.imdb_id, removed_at = excluded.removed_at`
  ).run(SPOKE, v.tmdbId, mediaType, cached?.imdb_id ?? null, Date.now());
}

export function listHouseholdRemovals(db: DB): HouseholdRemoval[] {
  return (db.prepare(
    'SELECT tmdb_id, media_type, imdb_id, removed_at FROM household_removals WHERE spoke = ?'
  ).all(SPOKE) as any[]).map((r) => ({
    tmdbId: r.tmdb_id,
    mediaType: r.media_type === 'tv' ? 'tv' : 'movie',
    imdbId: r.imdb_id ?? null,
    removedAt: r.removed_at
  }));
}

export function clearHouseholdRemovals(
  db: DB, keys: Array<{ tmdbId: number; mediaType: string }>
): void {
  if (keys.length === 0) return; // guard: a blanket DELETE here would drop pending work
  const stmt = db.prepare(
    'DELETE FROM household_removals WHERE spoke = ? AND tmdb_id = ? AND media_type = ?'
  );
  db.transaction(() => {
    for (const k of keys) stmt.run(SPOKE, k.tmdbId, k.mediaType === 'tv' ? 'tv' : 'movie');
  })();
}
