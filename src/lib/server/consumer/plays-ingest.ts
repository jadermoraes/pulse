import { z } from 'zod';
import type { DB } from '../db';
import type { Connection } from '../connections';

export interface RawPlay {
  rowId: number;
  ratingKey: string;
  grandparentRatingKey: string | null; // the SHOW's rating key; present on episodes, null on movies
  plexUserId: string;
  mediaType: string;
  watchedStatus: number;
  stoppedAt: number;   // seconds, as Tautulli reports it
  season: number | null;
  episode: number | null;
}

const HistoryEnvelope = z.object({
  response: z.object({
    result: z.string(),
    data: z.object({ data: z.array(z.record(z.string(), z.unknown())) })
  })
});

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Finished plays only. A partial play is not history.
 *
 * Also whitelisted to movie/episode: Tautulli history also includes music (`track`) and
 * extras/trailers (`clip`), and nothing upstream filters those out. Whitelisting here (rather
 * than defaulting unrecognized types to 'movie' downstream) keeps a mis-typed row from ever
 * reaching Trakt as a bogus movie watch.
 */
export function parseHistoryRows(data: unknown): RawPlay[] {
  const parsed = HistoryEnvelope.parse(data);
  if (parsed.response.result !== 'success') throw new Error('Tautulli error');
  return parsed.response.data.data
    .filter((r: any) => Number(r.watched_status ?? 0) === 1)
    .filter((r: any) => r.media_type === 'movie' || r.media_type === 'episode')
    .map((r: any) => ({
      rowId: Number(r.row_id),
      ratingKey: String(r.rating_key),
      grandparentRatingKey: r.grandparent_rating_key ? String(r.grandparent_rating_key) : null,
      plexUserId: String(r.user_id ?? ''),
      mediaType: String(r.media_type ?? ''),
      watchedStatus: Number(r.watched_status ?? 0),
      stoppedAt: Number(r.stopped ?? 0),
      season: num(r.parent_media_index),
      episode: num(r.media_index)
    }));
}

function cmdUrl(conn: Connection, cmd: string, extra: Record<string, string | number> = {}): string {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + '/api/v2');
  u.searchParams.set('apikey', conn.secret ?? '');
  u.searchParams.set('cmd', cmd);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function call(conn: Connection, cmd: string, extra: Record<string, string | number> = {}): Promise<any> {
  const res = await fetch(cmdUrl(conn, cmd, extra), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tautulli HTTP ${res.status}`);
  return res.json();
}

const MetadataEnvelope = z.object({
  response: z.object({
    result: z.string(),
    data: z.object({ guids: z.array(z.string()).optional() })
  })
});

/**
 * External ids for a rating_key, via get_metadata's `guids` array. Plex's per-row `guid` is
 * agent-dependent and unreliable, so this is the only source we trust. Cached permanently —
 * a rating_key's ids never change — so a Tautulli error envelope must never be cached: that
 * would make one transient hiccup mark the title unresolvable forever. Throwing here is caught
 * by the per-row isolation in ingestPlays, so the row is simply retried on the next poll.
 */
export async function resolveIds(
  db: DB, conn: Connection, ratingKey: string
): Promise<{ tmdbId: number | null; imdbId: string | null }> {
  const cached = db.prepare('SELECT tmdb_id, imdb_id FROM plex_guid_cache WHERE rating_key=?')
    .get(ratingKey) as any;
  if (cached) return { tmdbId: cached.tmdb_id ?? null, imdbId: cached.imdb_id ?? null };

  const parsed = MetadataEnvelope.parse(await call(conn, 'get_metadata', { rating_key: ratingKey }));
  if (parsed.response.result !== 'success') throw new Error('Tautulli error');
  const guids = parsed.response.data.guids ?? [];
  const imdb = guids.find((g) => g.startsWith('imdb://'))?.slice('imdb://'.length) ?? null;
  const tmdbRaw = guids.find((g) => g.startsWith('tmdb://'))?.slice('tmdb://'.length) ?? null;
  const tmdbId = tmdbRaw !== null ? num(tmdbRaw) : null;

  db.prepare('INSERT OR REPLACE INTO plex_guid_cache(rating_key,tmdb_id,imdb_id,cached_at) VALUES (?,?,?,?)')
    .run(ratingKey, tmdbId, imdb, Date.now());
  return { tmdbId, imdbId: imdb };
}

export function highestSourceRow(db: DB, source: string): number {
  const r = db.prepare('SELECT MAX(source_row) m FROM watch_plays WHERE source=?').get(source) as any;
  return Number(r?.m ?? 0);
}

/** Plex user id -> consumer id, from the existing consumer_users.plex_account_id mapping. */
function plexUserMap(db: DB): Map<string, number> {
  const rows = db.prepare(
    "SELECT id, plex_account_id FROM consumer_users WHERE plex_account_id IS NOT NULL AND plex_account_id <> ''"
  ).all() as any[];
  return new Map(rows.map((r) => [String(r.plex_account_id), Number(r.id)]));
}

const MAX_PAGES = 10;

// Every row_id comparison below assumes newest-first pages. Tautulli happens to default to
// that, but relying on a remote default means a future change there would silently stop
// ingestion rather than fail loudly — so the order is stated explicitly on every call.
const HISTORY_ORDER = { order_column: 'date', order_dir: 'desc' } as const;

/**
 * Fetch the history rows needed to close the gap between the last-ingested cursor and the
 * server's current history.
 *
 * Tautulli returns newest-first. When the cursor is 0 (nothing ingested yet for this source),
 * historical backfill is deliberately out of scope for Part 1 — an established Plex server's
 * pre-existing history, and a consumer's plays from before they linked, are deferred to a
 * later plan — so we fetch only the newest page and let the cursor start there.
 *
 * When the cursor is non-zero, a single page can miss a gap: if more than `pageSize` plays
 * accrued since the last run (e.g. pulse was down), the page's oldest row_id would still sit
 * above the cursor, and every row in between would be skipped forever once the cursor jumps to
 * this page's newest row. So we page backward with `start` until the page's minimum row_id
 * reaches the cursor or the server runs out of rows, capped at MAX_PAGES so one poller tick can
 * never run unbounded.
 */
async function fetchHistorySince(conn: Connection, cursor: number, pageSize: number): Promise<RawPlay[]> {
  if (cursor === 0) {
    return parseHistoryRows(await call(conn, 'get_history', { ...HISTORY_ORDER, length: pageSize }));
  }
  const rows: RawPlay[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await call(conn, 'get_history', {
      ...HISTORY_ORDER, length: pageSize, start: page * pageSize
    });

    // "Rows exhausted" / "gap closed" must be decided from the RAW page, not the filtered one:
    // parseHistoryRows already drops unfinished plays and non-movie/episode media types (music
    // tracks, extras), so a raw page can be a full page of history that filters down to zero or
    // to only recent-looking row_ids. Deciding from the filtered count would make the loop stop
    // believing the gap is closed while older movie/episode rows still sit beyond this offset —
    // silently re-introducing the data loss this loop exists to prevent.
    const envelope = HistoryEnvelope.parse(json);
    if (envelope.response.result !== 'success') throw new Error('Tautulli error');
    const rawRows = envelope.response.data.data;
    if (rawRows.length === 0) break; // server truly has no more history at this offset

    rows.push(...parseHistoryRows(json));

    const minRawRowId = Math.min(...rawRows.map((r: any) => Number(r.row_id)));
    if (minRawRowId <= cursor) break; // gap closed
  }
  return rows;
}

/**
 * Pull finished plays from Tautulli into watch_plays. Returns the number of rows inserted.
 *
 * Per-user filtering is a correctness requirement, not a nicety: Tautulli's history covers
 * everyone on the server, and a mis-attributed row would publish someone else's viewing to a
 * viewer's public Trakt profile. A play whose plex user matches no linked consumer is dropped.
 */
export async function ingestPlays(
  db: DB, conn: Connection, opts: { pageSize?: number } = {}
): Promise<number> {
  const pageSize = opts.pageSize ?? 200;
  const cursor = highestSourceRow(db, 'tautulli');
  const users = plexUserMap(db);
  if (users.size === 0) return 0;

  const rows = (await fetchHistorySince(conn, cursor, pageSize))
    .filter((p) => p.rowId > cursor)
    .filter((p) => users.has(p.plexUserId));

  const insert = db.prepare(
    `INSERT OR IGNORE INTO watch_plays
       (consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  let inserted = 0;
  for (const p of rows) {
    try {
      // Trakt keys TV history by SHOW id with seasons/episodes nested underneath, not by the
      // episode's own id — so an episode's tmdb/imdb ids must come from the show
      // (grandparent_rating_key), never the episode's own rating_key. Resolving from the wrong
      // key here would make Task 7's "already on Trakt?" match fail forever, re-pushing the
      // same episode on every poll. A row with no usable grandparent key is unresolvable by
      // definition and must be skipped, not silently fall back to the episode's own key.
      const isEpisode = p.mediaType === 'episode';
      if (isEpisode && !p.grandparentRatingKey) continue;
      const idKey = isEpisode ? p.grandparentRatingKey! : p.ratingKey;

      const ids = await resolveIds(db, conn, idKey);
      if (ids.tmdbId === null && ids.imdbId === null) continue; // unresolvable: never syncs, not an error
      const mediaType = isEpisode ? 'tv' : 'movie';
      const info = insert.run(
        users.get(p.plexUserId)!, ids.tmdbId, ids.imdbId, mediaType,
        p.season, p.episode, p.stoppedAt * 1000, 'tautulli', p.rowId
      );
      inserted += info.changes;
    } catch {
      // one bad title never blocks the rest — matches pollWatchlistAvailability's contract
    }
  }
  return inserted;
}
