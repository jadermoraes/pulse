import type { Connection } from '../connections';

export interface LibraryItem {
  jellyfinId: string;
  imdbId: string;
  type: 'movie' | 'series';
  name: string;
  year: number | null;
  posterTag: string | null;
}

/** Jellyfin authenticates by query parameter (see integrations/jellyfin.ts).
 *  Returns null for a baseUrl `new URL` cannot parse — a connection saved without a scheme
 *  (`192.168.1.5:8096`) is ordinary, and it must degrade like any other failure rather than
 *  throwing out of a module whose contract is "never throw". */
function jf(conn: Connection, path: string, query: Record<string, string> = {}): string | null {
  let u: URL;
  try {
    u = new URL(conn.baseUrl.replace(/\/$/, '') + path);
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  u.searchParams.set('api_key', conn.secret ?? '');
  return u.toString();
}

/**
 * Every Jellyfin call in the addon goes through here. Jellyfin being down must degrade to an empty
 * catalogue and no streams — never a 500 — because Stremio surfaces an addon error as a broken row
 * with no explanation, which is worse than an empty one.
 */
async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const IMDB_RE = /^tt\d+$/;

function toItem(raw: any, type: 'movie' | 'series'): LibraryItem | null {
  const imdbId = raw?.ProviderIds?.Imdb ?? raw?.ProviderIds?.IMDB ?? null;
  // No imdb id means Cinemeta cannot describe it, so it would render as an empty detail page.
  // Dropping it is better than surfacing an item nothing can explain.
  if (!imdbId || !IMDB_RE.test(imdbId) || !raw?.Id || !raw?.Name) return null;
  return {
    jellyfinId: String(raw.Id),
    imdbId,
    type,
    name: String(raw.Name),
    year: typeof raw.ProductionYear === 'number' ? raw.ProductionYear : null,
    posterTag: raw?.ImageTags?.Primary ?? null
  };
}

const JF_TYPE = { movie: 'Movie', series: 'Series' } as const;

export async function listLibrary(
  conn: Connection,
  o: { type: 'movie' | 'series'; skip: number; limit: number; search?: string }
): Promise<LibraryItem[]> {
  // The clamps guard the range but not the type: Math.min(200, NaN) is NaN, which would reach the
  // query string as `StartIndex=NaN`. Defence in depth — Task 3's parseExtras sanitises first.
  const skip = Number.isFinite(o.skip) ? Math.max(0, Math.floor(o.skip)) : 0;
  const limit = Number.isFinite(o.limit) ? Math.max(1, Math.min(200, Math.floor(o.limit))) : 100;
  const query: Record<string, string> = {
    Recursive: 'true',
    IncludeItemTypes: JF_TYPE[o.type],
    Fields: 'ProviderIds,ProductionYear',
    SortBy: o.search ? 'SortName' : 'DateCreated',
    SortOrder: o.search ? 'Ascending' : 'Descending',
    StartIndex: String(skip),
    Limit: String(limit)
  };
  if (o.search) query.SearchTerm = o.search;
  const url = jf(conn, '/Items', query);
  if (!url) return [];
  const data = await getJson(url);
  const items: any[] = Array.isArray(data?.Items) ? data.Items : [];
  return items.map((i) => toItem(i, o.type)).filter((i): i is LibraryItem => i !== null);
}

export async function findByImdb(
  conn: Connection, imdbId: string, type: 'movie' | 'series'
): Promise<LibraryItem | null> {
  // The id comes straight from a URL path. Shape-check before it reaches an upstream query string.
  if (!IMDB_RE.test(imdbId)) return null;
  const url = jf(conn, '/Items', {
    Recursive: 'true',
    IncludeItemTypes: JF_TYPE[type],
    Fields: 'ProviderIds,ProductionYear',
    AnyProviderIdEquals: `imdb.${imdbId}`,
    Limit: '1'
  });
  if (!url) return null;
  const data = await getJson(url);
  const raw = Array.isArray(data?.Items) ? data.Items[0] : null;
  return raw ? toItem(raw, type) : null;
}

export async function findEpisode(
  conn: Connection, seriesJellyfinId: string, season: number, episode: number
): Promise<string | null> {
  const url = jf(conn, `/Shows/${encodeURIComponent(seriesJellyfinId)}/Episodes`, {
    season: String(season),
    Fields: 'ProviderIds'
  });
  if (!url) return null;
  const data = await getJson(url);
  const items: any[] = Array.isArray(data?.Items) ? data.Items : [];
  // Match on BOTH numbers: `season=` is a hint Jellyfin does not always honour strictly, and
  // episode 5 of season 1 and of season 2 must never be confused.
  const hit = items.find((i) => i?.ParentIndexNumber === season && i?.IndexNumber === episode);
  return hit?.Id ? String(hit.Id) : null;
}

/** SERVER-SIDE ONLY. Carries the api key — never return this to a client.
 *  Null when the connection's baseUrl is unparseable; callers treat that as "no stream". */
export function upstreamStreamUrl(conn: Connection, jellyfinItemId: string): string | null {
  return jf(conn, `/Videos/${encodeURIComponent(jellyfinItemId)}/stream`, { static: 'true' });
}

/** SERVER-SIDE ONLY. Carries the api key — never return this to a client.
 *  Goes through `jf()` so the poster proxy gets the same `new URL()` validation the stream proxy
 *  does: a baseUrl saved without a scheme yields null here instead of a fetch of a string that
 *  contains the api key. Null when the baseUrl is unparseable; callers treat that as "no poster". */
export function upstreamPosterUrl(
  conn: Connection, jellyfinItemId: string, tag: string
): string | null {
  return jf(conn, `/Items/${encodeURIComponent(jellyfinItemId)}/Images/Primary`, {
    tag, maxWidth: '400'
  });
}
