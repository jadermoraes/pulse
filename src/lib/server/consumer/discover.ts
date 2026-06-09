import type { DB } from '../db';
import { listConnections, type Connection } from '../connections';
import { resolveWidget } from '../../widgets';
import { resolveAction } from '../actions';
import { joinUrl, getJsonWithKey } from '../http';
import { SEERR_PATHS, type DiscoverItem, type DiscoverResult, type DiscoverDetail } from './types';

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/w780';

/** Pure: true when `dateStr` parses to a moment on or before `nowMs`. Missing/unparseable ⇒ false. */
export function isReleased(dateStr: string | undefined, nowMs: number): boolean {
  if (!dateStr) return false;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return false;
  return t <= nowMs;
}

function mediaServer(db: DB): Connection | null {
  const c = listConnections(db).filter((x) => x.enabled);
  return c.find((x) => x.type === 'jellyfin') ?? c.find((x) => x.type === 'plex') ?? null;
}
function seerrConn(db: DB): Connection | null {
  return listConnections(db).find((c) => c.type === 'seerr' && c.enabled) ?? null;
}

function dedupeKey(i: DiscoverItem): string {
  return i.tmdbId != null ? `tmdb:${i.tmdbId}` : `t:${i.title.toLowerCase()}|${i.year ?? ''}`;
}

/** On-server item from a jellyfin/plex widget row; resolves the watch deep-link + proxied poster. */
async function onServerItem(db: DB, conn: Connection, row: any): Promise<DiscoverItem> {
  const mediaType: 'movie' | 'tv' = row.kind === 'Series' || row.kind === 'tv' ? 'tv' : 'movie';
  let watchUrl: string | undefined;
  try {
    const r = await resolveAction(db, conn.id, 'playInJellyfin', { id: row.id });
    if (r.ok && (r as any).url) watchUrl = (r as any).url;
  } catch { /* leave undefined */ }
  const poster = row.image ? `/api/image/${conn.id}?path=${encodeURIComponent(row.image)}` : undefined;
  return {
    source: conn.type === 'plex' ? 'plex' : 'jellyfin',
    title: row.title, year: row.year, poster, mediaType, onServer: true, watchUrl,
    released: true // on-server ⇒ available now
  };
}

function seerrItem(r: any, nowMs: number): DiscoverItem {
  const mediaType: 'movie' | 'tv' = r.mediaType === 'tv' ? 'tv' : 'movie';
  const title: string = (mediaType === 'tv' ? r.name : r.title) ?? `#${r.id}`;
  const date: string | undefined = mediaType === 'tv' ? r.firstAirDate : r.releaseDate;
  // seerr's real availability: mediaInfo.status 5 = Available, 1–4 = pending/processing/partial.
  const mediaStatus: number | undefined =
    typeof r.mediaInfo?.status === 'number' ? r.mediaInfo.status : undefined;
  const onServer = mediaStatus === 5;
  const requested = mediaStatus != null && mediaStatus >= 1 && mediaStatus < 5;
  return {
    source: 'seerr',
    title,
    year: date ? Number(date.slice(0, 4)) || undefined : undefined,
    poster: r.posterPath ? TMDB_IMG + r.posterPath : undefined,
    tmdbId: r.id,
    mediaType,
    onServer,
    rating: typeof r.voteAverage === 'number' ? Math.round(r.voteAverage * 10) / 10 : undefined,
    overview: r.overview || undefined,
    released: isReleased(date, nowMs),
    ...(requested ? { requested: true } : {})
  };
}

export async function getDiscover(db: DB): Promise<DiscoverResult> {
  const media = mediaServer(db);
  const seerr = seerrConn(db);

  const newOnServer: DiscoverItem[] = [];
  const continueWatching: DiscoverItem[] = [];
  if (media) {
    try {
      const recent = await resolveWidget(db, media.id, 'recentlyAdded');
      if (recent.ok && Array.isArray(recent.data))
        for (const row of recent.data) newOnServer.push(await onServerItem(db, media, row));
    } catch { /* source error → empty */ }
    try {
      const np = await resolveWidget(db, media.id, 'nowPlaying');
      if (np.ok && Array.isArray(np.data))
        for (const row of np.data) continueWatching.push(await onServerItem(db, media, row));
    } catch { /* source error → empty */ }
  }

  // Build a seen set that covers both tmdb-key and title-key for on-server items
  const seen = new Set<string>();
  for (const item of newOnServer) {
    seen.add(dedupeKey(item));
    // Also index by title|year so a seerr item with a tmdbId won't pass through if title matches
    seen.add(`t:${item.title.toLowerCase()}|${item.year ?? ''}`);
  }
  const hot: DiscoverItem[] = [];
  if (seerr) {
    const nowMs = Date.now();
    // Fetch hot movies and hot series from SEPARATE discover endpoints so BOTH rows fill.
    // The home/discover pages split `hot` by mediaType, so we just need plenty of each.
    const fetchRow = async (path: string) => {
      try {
        const d = await getJsonWithKey(joinUrl(seerr.baseUrl, path), seerr.secret);
        return (d.results ?? []) as any[];
      } catch {
        return [];
      }
    };
    const [movieResults, tvResults] = await Promise.all([
      fetchRow(SEERR_PATHS.discoverMovies),
      fetchRow(SEERR_PATHS.discoverTv)
    ]);
    // Force mediaType so /discover/movies and /discover/tv (which omit it) map correctly.
    const pushAll = (results: any[], forced: 'movie' | 'tv') => {
      for (const r of results) {
        const item = seerrItem({ ...r, mediaType: forced }, nowMs);
        if (!item.released) continue; // hot rows: released titles only (no in-cinemas/unreleased)
        const titleKey = `t:${item.title.toLowerCase()}|${item.year ?? ''}`;
        if (seen.has(dedupeKey(item)) || seen.has(titleKey)) continue;
        seen.add(dedupeKey(item));
        seen.add(titleKey);
        hot.push(item);
      }
    };
    pushAll(movieResults, 'movie');
    pushAll(tvResults, 'tv');
  }
  return { newOnServer, hot, continueWatching };
}

export async function searchDiscover(db: DB, q: string): Promise<DiscoverItem[]> {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const media = mediaServer(db);
  const out: DiscoverItem[] = [];
  const seen = new Set<string>();

  const seerr = seerrConn(db);
  // Availability is driven SOLELY by seerr's mediaInfo.status (see seerrItem): status 5 ⇒
  // available now (onServer), 1–4 ⇒ already requested/processing (NOT available). We no longer
  // infer availability from Jellyfin's recently-added list — that list contains the placeholder
  // entries Radarr/Sonarr create for requested-but-undownloaded titles, which made
  // requested-but-unavailable items wrongly surface under "Available now".
  const seerrTitleKeys = new Set<string>();
  if (seerr) {
    try {
      // seerr rejects '+' in the query (it requires %20), so percent-encode explicitly
      // instead of going through joinUrl/URLSearchParams (which encodes spaces as '+').
      const searchUrl =
        `${seerr.baseUrl.replace(/\/$/, '')}${SEERR_PATHS.search}?query=${encodeURIComponent(q)}`;
      const d = await getJsonWithKey(searchUrl, seerr.secret);
      const nowMs = Date.now();
      for (const r of (d.results ?? [])) {
        if (r.mediaType !== 'movie' && r.mediaType !== 'tv') continue;
        const item = seerrItem(r, nowMs);
        seerrTitleKeys.add(`t:${item.title.toLowerCase()}|${item.year ?? ''}`);
        if (!seen.has(dedupeKey(item))) { seen.add(dedupeKey(item)); out.push(item); }
      }
    } catch { /* seerr down ⇒ fall back to on-server hits below */ }
  }

  // Jellyfin recently-added hits supply the watch deep-link, but ONLY for titles seerr did not
  // already cover (so seerr's authoritative availability/requested status wins). When seerr is
  // unavailable, these still let the user find + open something that's genuinely on the server.
  if (media) {
    try {
      const recent = await resolveWidget(db, media.id, 'recentlyAdded');
      if (recent.ok && Array.isArray(recent.data))
        for (const row of recent.data)
          if (String(row.title).toLowerCase().includes(query)) {
            const item = await onServerItem(db, media, row);
            const titleKey = `t:${item.title.toLowerCase()}|${item.year ?? ''}`;
            if (seerrTitleKeys.has(titleKey)) continue; // seerr already decided this title's state
            if (!seen.has(dedupeKey(item))) { seen.add(dedupeKey(item)); out.push(item); }
          }
    } catch { /* source error → seerr hits only */ }
  }

  // On-server / available items first (Watch), then requestable + already-requested ones.
  return out.sort((a, b) => Number(b.onServer) - Number(a.onServer));
}

/**
 * Rich detail for the consumer movie/series modal. Resolves seerr
 * `/api/v1/movie/{tmdbId}` or `/api/v1/tv/{tmdbId}` into a normalized payload.
 * Returns null when there is no enabled seerr connection.
 */
export async function getDetail(
  db: DB,
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  language: string = 'en'
): Promise<DiscoverDetail | null> {
  const seerr = seerrConn(db);
  if (!seerr) return null;

  const base = mediaType === 'tv' ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
  // Ask seerr/TMDB for the viewer's language so the overview/synopsis + genres come localized.
  const path = `${base}?language=${encodeURIComponent(language)}`;
  let m: any;
  try {
    m = await getJsonWithKey(joinUrl(seerr.baseUrl, path), seerr.secret);
  } catch {
    return null; // seerr unreachable → treat as "no source configured" (same as no connection)
  }

  const title: string = (mediaType === 'tv' ? m.name : m.title) ?? `${mediaType} #${tmdbId}`;
  const date: string | undefined =
    (mediaType === 'tv' ? m.firstAirDate : m.releaseDate) || undefined;
  const year = date ? Number(date.slice(0, 4)) || undefined : undefined;
  const runtimeMin: number | undefined =
    mediaType === 'tv'
      ? (Array.isArray(m.episodeRunTime) ? m.episodeRunTime[0] : undefined)
      : (typeof m.runtime === 'number' && m.runtime > 0 ? m.runtime : undefined);
  const genres: string[] = Array.isArray(m.genres)
    ? m.genres.map((g: any) => g?.name).filter(Boolean)
    : [];
  const rating = typeof m.voteAverage === 'number' ? Math.round(m.voteAverage * 10) / 10 : undefined;
  const poster = m.posterPath ? TMDB_IMG + m.posterPath : undefined;
  const backdrop = m.backdropPath ? TMDB_BACKDROP + m.backdropPath : undefined;

  const mediaStatus: number | undefined =
    typeof m.mediaInfo?.status === 'number' ? m.mediaInfo.status : undefined;
  const available = mediaStatus === 5;
  // Human label for the modal's primary CTA region.
  const status = available
    ? 'Available'
    : (mediaStatus != null && mediaStatus > 1) ? 'Requested' : 'Not on server';

  return {
    title, year, overview: m.overview || undefined, genres, rating, runtimeMin,
    poster, backdrop, available, status
  };
}
