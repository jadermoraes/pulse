import { z } from 'zod';
import type { DB } from '../db';
import type { Connection } from '../connections';

export interface JellystatPlay {
  activityId: string;
  jellyfinUserId: string;
  itemId: string;             // NowPlayingItemId: for an episode this is the SERIES, not the episode
  episodeId: string | null;   // null for movies
  season: number | null;
  episode: number | null;
  playbackSeconds: number;
  watchedAt: number;          // ms epoch
}

interface JellyfinItemInfo {
  itemType: string | null;    // null for a negative-cache entry: Jellyfin has no such item
  tmdbId: number | null;
  imdbId: string | null;
  runtimeSeconds: number | null;
}

/** Ingest only when a play reaches this fraction of the item's runtime. */
export const COMPLETION_RATIO = 0.9;

/** /Items?ids= is a single URL query string; chunking keeps it well clear of a 414. */
const ITEMS_CHUNK_SIZE = 100;

const JellystatRow = z.object({
  Id: z.string(),
  UserId: z.string().nullish(),
  NowPlayingItemId: z.string(),
  EpisodeId: z.string().nullish(),
  SeasonNumber: z.number().nullish(),
  EpisodeNumber: z.number().nullish(),
  PlaybackDuration: z.number(),
  ActivityDateInserted: z.string()
});

// Jellystat's /api/getHistory returns either a bare array or a { results: [...] } envelope
// (both shapes have been observed live).
const JellystatEnvelope = z.union([
  z.array(JellystatRow),
  z.object({ results: z.array(JellystatRow) })
]);

/**
 * Zod-validated, tolerant of both payload envelopes. `watchedAt` is converted to ms epoch —
 * every other timestamp in `watch_plays` is ms.
 */
export function parseJellystatRows(payload: unknown): JellystatPlay[] {
  const parsed = JellystatEnvelope.parse(payload);
  const rows = Array.isArray(parsed) ? parsed : parsed.results;
  return rows.map((r) => ({
    activityId: r.Id,
    jellyfinUserId: r.UserId ?? '',
    itemId: r.NowPlayingItemId,
    episodeId: r.EpisodeId ?? null,
    season: r.SeasonNumber ?? null,
    episode: r.EpisodeNumber ?? null,
    playbackSeconds: r.PlaybackDuration,
    watchedAt: Date.parse(r.ActivityDateInserted)
  }));
}

async function fetchHistory(conn: Connection): Promise<unknown> {
  const url = conn.baseUrl.replace(/\/$/, '') + '/api/getHistory';
  const res = await fetch(url, {
    headers: { 'x-api-token': conn.secret ?? '', Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Jellystat HTTP ${res.status}`);
  return res.json();
}

// `.nullish()` (not `.optional()`) on RunTimeTicks/ProviderIds and its values: a live item can
// serialise an explicit `null` for either, and that must be tolerated as "no data" rather than
// aborting the whole ingest — only genuine shape drift (a missing/renamed field entirely, a
// non-object Items array, ...) should still throw.
const JellyfinItemsResponse = z.object({
  Items: z.array(z.object({
    Id: z.string(),
    Type: z.string(),
    ProviderIds: z.record(z.string(), z.string().nullish()).nullish(),
    RunTimeTicks: z.number().nullish()
  }))
});

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Resolve Jellyfin item ids to their provider ids + runtime, batching `/Items?ids=` calls (at
 * most `ITEMS_CHUNK_SIZE` ids per request) for whatever isn't already cached. Cached permanently
 * — a Jellyfin item's provider ids and runtime do not change — so a cache hit never re-fetches.
 *
 * An id Jellyfin does not return (deleted, or never existed) gets a negative-cache row (all
 * fields NULL) rather than being left unresolved: without this, and with no cursor to eventually
 * stop re-examining old activities (see ingestJellystatPlays), that id would be re-fetched from
 * Jellyfin on every single poll, forever.
 */
export async function resolveJellyfinItems(
  db: DB, jellyfinConn: Connection, itemIds: string[]
): Promise<Map<string, JellyfinItemInfo>> {
  const unique = [...new Set(itemIds)];
  const result = new Map<string, JellyfinItemInfo>();
  const missing: string[] = [];

  for (const id of unique) {
    const cached = db.prepare(
      'SELECT item_type, tmdb_id, imdb_id, runtime_seconds FROM jellyfin_item_cache WHERE item_id=?'
    ).get(id) as any;
    if (cached) {
      result.set(id, {
        itemType: cached.item_type ?? null, tmdbId: cached.tmdb_id ?? null,
        imdbId: cached.imdb_id ?? null, runtimeSeconds: cached.runtime_seconds ?? null
      });
    } else {
      missing.push(id);
    }
  }
  if (missing.length === 0) return result;

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO jellyfin_item_cache(item_id,item_type,tmdb_id,imdb_id,runtime_seconds,cached_at)
     VALUES (?,?,?,?,?,?)`
  );

  for (const batch of chunk(missing, ITEMS_CHUNK_SIZE)) {
    const url = new URL(jellyfinConn.baseUrl.replace(/\/$/, '') + '/Items');
    url.searchParams.set('ids', batch.join(','));
    url.searchParams.set('fields', 'ProviderIds,RunTimeTicks');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `MediaBrowser Token="${jellyfinConn.secret ?? ''}"`, Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
    const parsed = JellyfinItemsResponse.parse(await res.json());

    const returned = new Set<string>();
    for (const item of parsed.Items) {
      returned.add(item.Id);
      const tmdbId = num(item.ProviderIds?.Tmdb);
      const imdbId = item.ProviderIds?.Imdb ?? null;
      // RunTimeTicks are 100-nanosecond units; seconds = ticks / 10_000_000.
      const runtimeSeconds = item.RunTimeTicks != null ? Math.floor(item.RunTimeTicks / 10_000_000) : null;
      const info: JellyfinItemInfo = { itemType: item.Type, tmdbId, imdbId, runtimeSeconds };
      result.set(item.Id, info);
      upsert.run(item.Id, info.itemType, info.tmdbId, info.imdbId, info.runtimeSeconds, Date.now());
    }
    for (const id of batch) {
      if (returned.has(id)) continue;
      const info: JellyfinItemInfo = { itemType: null, tmdbId: null, imdbId: null, runtimeSeconds: null };
      result.set(id, info);
      upsert.run(id, null, null, null, null, Date.now());
    }
  }
  return result;
}

/** Jellyfin user id -> consumer id, from the existing consumer_users.jellyfin_user_id mapping. */
function jellyfinUserMap(db: DB): Map<string, number> {
  const rows = db.prepare(
    "SELECT id, jellyfin_user_id FROM consumer_users WHERE jellyfin_user_id IS NOT NULL AND jellyfin_user_id <> ''"
  ).all() as any[];
  return new Map(rows.map((r) => [String(r.jellyfin_user_id), Number(r.id)]));
}

/**
 * Pull finished plays from Jellystat into watch_plays. Returns the number of rows inserted.
 *
 * Attribution is a correctness requirement: Jellystat's history covers every Jellyfin user on
 * the server, and a mis-attributed row would publish someone else's viewing to a viewer's public
 * Trakt profile. A row whose UserId matches no linked consumer (by jellyfin_user_id, never
 * UserName) is dropped. `idx_consumer_jellyfin` (see db.ts) guarantees jellyfin_user_id is unique
 * per non-blank value, so this map can never resolve to the wrong consumer.
 *
 * Deliberately no cursor: `ActivityDateInserted` is the session's START time, not its completion
 * time, so it cannot be used as a watermark. Two overlapping sessions make this concrete: if
 * consumer A starts a film at 19:00 and consumer B starts and finishes a short episode at 19:05,
 * a watched_at-based cursor would advance to 19:05 on that poll — and A's film, finished later but
 * still timestamped 19:00, would sit below the cursor forever, never ingested. `/api/getHistory`
 * is a bounded recent list, and INSERT OR IGNORE against the existing
 * UNIQUE(consumer_id, source, source_row) already dedupes by activity UUID, so re-examining every
 * returned row on every poll is correct — and, with the permanent item cache, cheap on a warm run.
 *
 * `/api/getHistory` pagination is deliberately out of scope, mirroring the Tautulli ingest's
 * descope of historical backfill.
 */
export async function ingestJellystatPlays(
  db: DB, jellystatConn: Connection, jellyfinConn: Connection
): Promise<number> {
  const users = jellyfinUserMap(db);
  if (users.size === 0) return 0;

  const rows = parseJellystatRows(await fetchHistory(jellystatConn))
    .filter((p) => users.has(p.jellyfinUserId));
  if (rows.length === 0) return 0;

  // For an episode, NowPlayingItemId resolves to the SERIES (whose ProviderIds are the show-level
  // ids Trakt needs), while the Series' RunTimeTicks is 0 — so the EPISODE's own runtime, via
  // EpisodeId, is fetched in the same batched call for the completion check.
  const idsToResolve = new Set<string>();
  for (const p of rows) {
    idsToResolve.add(p.itemId);
    if (p.episodeId) idsToResolve.add(p.episodeId);
  }
  const items = await resolveJellyfinItems(db, jellyfinConn, [...idsToResolve]);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO watch_plays
       (consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  let inserted = 0;
  for (const p of rows) {
    try {
      const itemInfo = items.get(p.itemId);
      if (!itemInfo) continue; // unresolvable: never syncs, not an error

      // Mirrors plays-ingest.ts's resolveIds guard: a play with no resolvable external ids
      // (an unmatched file, a home video, a negative-cache entry) can never sync to Trakt and
      // would otherwise be re-pushed — and re-fail as "not found" — on every run, forever.
      if (itemInfo.tmdbId === null && itemInfo.imdbId === null) continue;

      // Whitelist, mirroring the Tautulli ingest: an unrecognized item type (Audio, MusicVideo,
      // Trailer, ...) is skipped, never defaulted to 'movie'.
      const mediaType = itemInfo.itemType === 'Movie' ? 'movie'
        : itemInfo.itemType === 'Series' ? 'tv'
        : null;
      if (mediaType === null) continue;

      // A TV play without both season and episode can never be posted to Trakt (which keys TV
      // history by show id + season + episode) and would otherwise be re-selected forever.
      if (mediaType === 'tv' && (p.season === null || p.episode === null)) continue;

      let runtimeSeconds: number | null;
      if (mediaType === 'tv') {
        if (!p.episodeId) continue; // no episode id: completion cannot be checked, never assume finished
        runtimeSeconds = items.get(p.episodeId)?.runtimeSeconds ?? null;
      } else {
        runtimeSeconds = itemInfo.runtimeSeconds;
      }
      if (!runtimeSeconds || runtimeSeconds <= 0) continue; // missing/0 runtime: never assume finished
      if (p.playbackSeconds < COMPLETION_RATIO * runtimeSeconds) continue;

      const info = insert.run(
        users.get(p.jellyfinUserId)!, itemInfo.tmdbId, itemInfo.imdbId, mediaType,
        mediaType === 'tv' ? p.season : null, mediaType === 'tv' ? p.episode : null,
        p.watchedAt, 'jellystat', p.activityId
      );
      inserted += info.changes;
    } catch {
      // one bad activity never blocks the rest — matches ingestPlays' contract
    }
  }
  return inserted;
}
