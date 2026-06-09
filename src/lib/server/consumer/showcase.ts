// Public showcase posters for the cinematic login + onboarding backdrops.
//
// Returns ~20 PUBLIC TMDB poster image URLs (https://image.tmdb.org/t/p/w342<path>)
// pulled from the seerr trending endpoint server-side. This deliberately exposes ONLY
// public TMDB poster paths — never the private library, watch deep-links, or any secret.
// The result is cached in memory for a few minutes so the unauthenticated login/join
// pages don't hammer seerr on every visit.

import type { DB } from '../db';
import { listConnections, type Connection } from '../connections';
import { joinUrl, getJsonWithKey } from '../http';
import { SEERR_PATHS } from './types';

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_POSTERS = 20;
const MAX_TITLES = 8;

let cache: { at: number; posters: string[] } | null = null;
let titleCache: { at: number; titles: ShowcaseTitles } | null = null;

/** A public, poster-bearing title card for the onboarding "available"/"request" beats. */
export interface ShowcaseTitle {
  title: string;
  year?: number;
  poster: string; // public TMDB URL
  rating?: number;
  mediaType: 'movie' | 'tv';
}

/**
 * Two real, deduped lists for the onboarding beats:
 *  - `available`: titles genuinely ON the server (seerr mediaInfo.status === 5) → "▶ Watch now"
 *  - `request`:   trending titles NOT on the server (and not already requested) → "+ Request"
 * Both carry only PUBLIC TMDB posters — never the private library proxy (which needs auth and
 * wouldn't load on the pre-session join page anyway).
 */
export interface ShowcaseTitles {
  available: ShowcaseTitle[];
  request: ShowcaseTitle[];
}

function seerrConn(db: DB): Connection | null {
  return listConnections(db).find((c) => c.type === 'seerr' && c.enabled) ?? null;
}

/**
 * Public TMDB poster URLs from seerr trending. Cached in memory for a few minutes.
 * No seerr connection (or seerr down) ⇒ `[]` so the UI falls back to a gradient backdrop.
 */
export async function getShowcasePosters(db: DB): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.posters;

  const seerr = seerrConn(db);
  if (!seerr) {
    cache = { at: Date.now(), posters: [] };
    return [];
  }

  const posters: string[] = [];
  try {
    const d = await getJsonWithKey(joinUrl(seerr.baseUrl, SEERR_PATHS.trending), seerr.secret);
    for (const r of d.results ?? []) {
      // Only public movie/tv items with a TMDB poster path — nothing server-private.
      if (r.mediaType !== 'movie' && r.mediaType !== 'tv') continue;
      if (typeof r.posterPath !== 'string' || !r.posterPath) continue;
      posters.push(TMDB_IMG + r.posterPath);
      if (posters.length >= MAX_POSTERS) break;
    }
  } catch {
    // seerr down ⇒ empty list (UI falls back to a gradient backdrop).
  }

  cache = { at: Date.now(), posters };
  return posters;
}

/**
 * Real on-server vs. requestable title cards for onboarding, built from seerr's discover
 * endpoints (trending + popular movies + popular TV). Availability is seerr's own
 * `mediaInfo.status` (5 = on server), so the "available" beat never lies. Cached a few minutes.
 * No seerr connection ⇒ empty lists (the UI falls back to gradient placeholders).
 */
export async function getShowcaseTitles(db: DB): Promise<ShowcaseTitles> {
  if (titleCache && Date.now() - titleCache.at < CACHE_TTL_MS) return titleCache.titles;

  const seerr = seerrConn(db);
  if (!seerr) {
    const empty = { available: [], request: [] };
    titleCache = { at: Date.now(), titles: empty };
    return empty;
  }

  const fetchRow = async (path: string): Promise<any[]> => {
    try {
      const d = await getJsonWithKey(joinUrl(seerr.baseUrl, path), seerr.secret);
      return (d.results ?? []) as any[];
    } catch {
      return [];
    }
  };

  const [trending, movies, tv] = await Promise.all([
    fetchRow(SEERR_PATHS.trending),
    fetchRow(SEERR_PATHS.discoverMovies),
    fetchRow(SEERR_PATHS.discoverTv)
  ]);

  const available: ShowcaseTitle[] = [];
  const request: ShowcaseTitle[] = [];
  const seen = new Set<string>();

  const consider = (r: any, forced?: 'movie' | 'tv') => {
    const mediaType: 'movie' | 'tv' =
      forced ?? (r.mediaType === 'tv' ? 'tv' : r.mediaType === 'movie' ? 'movie' : 'movie');
    if (!forced && r.mediaType !== 'movie' && r.mediaType !== 'tv') return;
    if (typeof r.posterPath !== 'string' || !r.posterPath) return;
    const title: string = (mediaType === 'tv' ? r.name : r.title) ?? '';
    if (!title) return;
    const date: string | undefined = mediaType === 'tv' ? r.firstAirDate : r.releaseDate;
    const year = date ? Number(String(date).slice(0, 4)) || undefined : undefined;
    const key = `${title.toLowerCase()}|${year ?? ''}`;
    if (seen.has(key)) return;

    const status: number | undefined =
      typeof r.mediaInfo?.status === 'number' ? r.mediaInfo.status : undefined;
    const onServer = status === 5;
    const requested = status != null && status >= 1 && status < 5;
    const card: ShowcaseTitle = {
      title,
      year,
      poster: TMDB_IMG + r.posterPath,
      rating: typeof r.voteAverage === 'number' ? Math.round(r.voteAverage * 10) / 10 : undefined,
      mediaType
    };
    if (onServer) {
      if (available.length >= MAX_TITLES) return;
      seen.add(key);
      available.push(card);
    } else if (!requested) {
      if (request.length >= MAX_TITLES) return;
      seen.add(key);
      request.push(card);
    }
  };

  for (const r of trending) consider(r);
  for (const r of movies) consider(r, 'movie');
  for (const r of tv) consider(r, 'tv');

  const titles = { available, request };
  titleCache = { at: Date.now(), titles };
  return titles;
}

/** Test-only: reset the in-memory cache so tests don't bleed into each other. */
export function _resetShowcaseCache(): void {
  cache = null;
  titleCache = null;
}
