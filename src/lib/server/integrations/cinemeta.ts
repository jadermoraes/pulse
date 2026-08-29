import { z } from 'zod';
import type { DB } from '../db';

// Cinemeta is Stremio's own metadata addon: free, unauthenticated, and the same catalogue
// Stremio itself resolves against — which makes it the right source for both the reverse
// imdb -> tmdb lookup and the name/poster used when pulse creates a library item.
const BASE = 'https://v3-cinemeta.strem.io';

export interface CinemetaMeta {
  imdbId: string;
  tmdbId: number | null;
  name: string;
  poster: string | null;
  type: 'movie' | 'series';
}

const MetaResponse = z.object({
  meta: z.object({
    imdb_id: z.string().nullish(),
    id: z.string(),
    moviedb_id: z.number().nullish(),
    name: z.string(),
    poster: z.string().nullish(),
    type: z.enum(['movie', 'series'])
  })
});

export async function fetchCinemetaMeta(
  imdbId: string, type: 'movie' | 'series'
): Promise<CinemetaMeta | null> {
  const res = await fetch(`${BASE}/meta/${type}/${imdbId}.json`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cinemeta HTTP ${res.status}`);
  const d = MetaResponse.parse(await res.json()).meta;
  return {
    imdbId: d.imdb_id ?? d.id,
    tmdbId: d.moviedb_id ?? null,
    name: d.name,
    poster: d.poster ?? null,
    type: d.type
  };
}

/** Cached wrapper. Cinemeta's answer for an imdb id never changes, so the cache never expires. */
export async function resolveImdbMeta(
  db: DB, imdbId: string, type: 'movie' | 'series'
): Promise<CinemetaMeta | null> {
  const row = db.prepare('SELECT * FROM imdb_meta_cache WHERE imdb_id=? AND media_type=?')
    .get(imdbId, type) as any;
  if (row) {
    if (!row.found) return null;
    return { imdbId, tmdbId: row.tmdb_id ?? null, name: row.name, poster: row.poster ?? null, type };
  }

  const meta = await fetchCinemetaMeta(imdbId, type);
  db.prepare(
    `INSERT OR REPLACE INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(imdbId, type, meta?.tmdbId ?? null, meta?.name ?? null, meta?.poster ?? null, meta ? 1 : 0, Date.now());
  return meta;
}
