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

/** One page of `/Items`. Returns the RAW upstream count alongside the mapped items: the mapping
 *  drops anything without an imdb id, so `items.length` alone cannot tell a short final page from
 *  a full page that happened to be mostly unmapped. Null means the call failed — distinct from a
 *  page that legitimately came back empty. */
async function fetchPage(
  conn: Connection,
  o: { type: 'movie' | 'series'; skip: number; limit: number; search?: string }
): Promise<{ raw: number; items: LibraryItem[] } | null> {
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
  if (!url) return null;
  const data = await getJson(url);
  if (data === null) return null;
  const raw: any[] = Array.isArray(data?.Items) ? data.Items : [];
  return {
    raw: raw.length,
    items: raw.map((i) => toItem(i, o.type)).filter((i): i is LibraryItem => i !== null)
  };
}

export async function listLibrary(
  conn: Connection,
  o: { type: 'movie' | 'series'; skip: number; limit: number; search?: string }
): Promise<LibraryItem[]> {
  return (await fetchPage(conn, o))?.items ?? [];
}

/**
 * Jellyfin 10.11 has NO provider-id filter on `/Items`. `AnyProviderIdEquals` is absent from its
 * OpenAPI spec and is silently IGNORED rather than rejected, so the "filtered" query returns the
 * entire library and `Limit=1` hands back an arbitrary first row. Verified against 10.11.10: a
 * real id and an invented one both answered `TotalRecordCount: 38` with the same title — which
 * is why every title in Stremio offered to play the same film, and why nothing ever looked
 * missing enough to offer a request.
 *
 * So the match happens here, not upstream: pull the library once and index it by imdb id. A
 * homelab library is small (this one is 38 movies and 16 series; the full fetch takes 8ms), and
 * the TTL keeps a freshly-added title at most a minute from being playable.
 */
const INDEX_TTL_MS = 60_000;
const INDEX_PAGE = 200;
/** A ceiling on paging, so a server that ignores StartIndex the way it ignored the provider
 *  filter cannot spin here forever. 200 pages x 200 = 40k titles. */
const INDEX_MAX_PAGES = 200;

interface CachedIndex { at: number; byImdb: Map<string, LibraryItem>; }
const indexes = new Map<string, CachedIndex>();

/** Keyed on the connection's identity AND its address: re-pointing Jellyfin at another server
 *  must not be answered from the previous one's index. */
function indexKey(conn: Connection, type: 'movie' | 'series'): string {
  return `${conn.id}\u0000${conn.baseUrl}\u0000${type}`;
}

/** Test seam. The index is process-global, so a test that does not clear it would otherwise see
 *  another test's library. */
export function _resetLibraryIndex(): void {
  indexes.clear();
}

async function libraryIndex(
  conn: Connection, type: 'movie' | 'series'
): Promise<Map<string, LibraryItem> | null> {
  const key = indexKey(conn, type);
  const cached = indexes.get(key);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.byImdb;

  const byImdb = new Map<string, LibraryItem>();
  for (let page = 0; page < INDEX_MAX_PAGES; page++) {
    const got = await fetchPage(conn, { type, skip: page * INDEX_PAGE, limit: INDEX_PAGE });
    // A failed page means the index is incomplete. Caching it would turn one bad request into a
    // minute of "you do not own this" for titles that are right there — so give up on this
    // attempt entirely and leave the previous index (or nothing) in place.
    if (got === null) return null;
    // First writer wins: if two library folders carry the same title, the earlier page is the
    // one the catalogue also shows first.
    for (const item of got.items) if (!byImdb.has(item.imdbId)) byImdb.set(item.imdbId, item);
    if (got.raw < INDEX_PAGE) break;
  }
  indexes.set(key, { at: Date.now(), byImdb });
  return byImdb;
}

export async function findByImdb(
  conn: Connection, imdbId: string, type: 'movie' | 'series'
): Promise<LibraryItem | null> {
  // The id comes straight from a URL path. Shape-check before it is used as a lookup key.
  if (!IMDB_RE.test(imdbId)) return null;
  const index = await libraryIndex(conn, type);
  return index?.get(imdbId) ?? null;
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
