import { z } from 'zod';

const API = 'https://api.trakt.tv';
const OOB = 'urn:ietf:wg:oauth:2.0:oob';

/**
 * An HTTP-level Trakt failure, carrying the status so callers can tell an auth failure
 * (the credential is dead — relinking is the only fix) from a transient one (network blip,
 * 429, 5xx). Counting a transient failure toward MAX_FAILS would let a ten-minute Trakt
 * outage permanently disable a perfectly good link.
 */
export class TraktHttpError extends Error {
  readonly status: number;
  constructor(status: number, what: string) {
    super(`Trakt ${what} HTTP ${status}`);
    this.name = 'TraktHttpError';
    this.status = status;
  }
}

function clientId(): string { return (process.env.PULSE_TRAKT_CLIENT_ID ?? '').trim(); }
function clientSecret(): string { return (process.env.PULSE_TRAKT_CLIENT_SECRET ?? '').trim(); }

export function traktConfigured(): boolean {
  return clientId() !== '' && clientSecret() !== '';
}

/** Headers every Trakt call needs. `http.ts` sends X-Api-Key and is not usable here. */
export function traktHeaders(accessToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId()
  };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

async function post(path: string, body: unknown, accessToken?: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: traktHeaders(accessToken),
    body: JSON.stringify(body)
  });
}

const DeviceCode = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_url: z.string(),
  expires_in: z.number(),
  interval: z.number()
});

export async function requestDeviceCode() {
  const res = await post('/oauth/device/code', { client_id: clientId() });
  if (!res.ok) throw new TraktHttpError(res.status, 'device code');
  const d = DeviceCode.parse(await res.json());
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUrl: d.verification_url,
    expiresIn: d.expires_in,
    interval: d.interval
  };
}

const Token = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number()
});

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'ok'; accessToken: string; refreshToken: string; expiresAt: number };

export async function pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
  const res = await post('/oauth/device/token', {
    code: deviceCode, client_id: clientId(), client_secret: clientSecret()
  });
  // Trakt device flow: 400 = still pending, 410 = expired, 409 = already used, 418 = denied.
  if (res.status === 400) return { status: 'pending' };
  if (res.status === 410 || res.status === 409 || res.status === 418) return { status: 'expired' };
  if (!res.ok) throw new TraktHttpError(res.status, 'device token');
  const t = Token.parse(await res.json());
  return {
    status: 'ok',
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000
  };
}

export async function refreshToken(refresh: string) {
  const res = await post('/oauth/token', {
    refresh_token: refresh,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: OOB,
    grant_type: 'refresh_token'
  });
  if (!res.ok) throw new TraktHttpError(res.status, 'refresh');
  const t = Token.parse(await res.json());
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000
  };
}

export interface TraktPlay {
  tmdbId: number | null;
  imdbId: string | null;
  mediaType: 'movie' | 'tv';
  season: number | null;
  episode: number | null;
  watchedAt: number; // ms epoch
}

/** Stable key for "does Trakt already have this play". */
export function playKey(p: TraktPlay): string[] {
  const suffix = p.mediaType === 'tv' && p.season !== null && p.episode !== null
    ? `:s${p.season}e${p.episode}` : '';
  const keys: string[] = [];
  if (p.imdbId) keys.push(`imdb:${p.imdbId}${suffix}`);
  if (p.tmdbId !== null) keys.push(`tmdb:${p.tmdbId}${suffix}`);
  return keys;
}

// Trakt returns many more id providers (trakt, slug, tvdb, tvrage…) and many more fields per
// entry; zod's default strip keeps this tolerant of all of them. It is strict only about the
// two fields actually read, and about `seasons` being present on a show — because a silent
// shape drift there would yield an EMPTY watched set, which makes `selectUnsynced` consider
// nothing synced and re-POST the consumer's whole stored history to their public profile.
// That duplicate-history outcome is the one this design exists to prevent, so an unparseable
// response must abort the sync rather than fall through as "Trakt has nothing".
const WatchedIds = z.object({
  imdb: z.string().nullish(),
  tmdb: z.number().nullish()
});
const WatchedMovies = z.array(z.object({ movie: z.object({ ids: WatchedIds }) }));
const WatchedShows = z.array(z.object({
  show: z.object({ ids: WatchedIds }),
  seasons: z.array(z.object({
    number: z.number(),
    episodes: z.array(z.object({ number: z.number() }))
  }))
}));

/**
 * The set of plays Trakt already has. Used to make history sync a gap-filler: the scrobble
 * path (Part 1 of the spec's stage 3) also writes history, so pushing everything would double up.
 *
 * Throws on an unparseable response; `pollTraktHistory`'s per-consumer catch turns that into a
 * recorded failure. An empty array is legitimate and parses to an empty set.
 */
export async function getWatchedIds(accessToken: string, type: 'movies' | 'shows'): Promise<Set<string>> {
  const res = await fetch(`${API}/sync/watched/${type}`, { headers: traktHeaders(accessToken) });
  if (!res.ok) throw new TraktHttpError(res.status, 'watched');
  const body = await res.json();
  const out = new Set<string>();

  if (type === 'movies') {
    for (const entry of WatchedMovies.parse(body)) {
      const ids = entry.movie.ids;
      if (ids.imdb) out.add(`imdb:${ids.imdb}`);
      if (ids.tmdb != null) out.add(`tmdb:${ids.tmdb}`);
    }
    return out;
  }

  for (const entry of WatchedShows.parse(body)) {
    const ids = entry.show.ids;
    for (const season of entry.seasons) {
      for (const ep of season.episodes) {
        const suffix = `:s${season.number}e${ep.number}`;
        if (ids.imdb) out.add(`imdb:${ids.imdb}${suffix}`);
        if (ids.tmdb != null) out.add(`tmdb:${ids.tmdb}${suffix}`);
      }
    }
  }
  return out;
}

function idsOf(p: TraktPlay): Record<string, string | number> {
  const ids: Record<string, string | number> = {};
  if (p.imdbId) ids.imdb = p.imdbId;
  if (p.tmdbId !== null) ids.tmdb = p.tmdbId;
  return ids;
}

interface ShowEntry {
  ids: Record<string, string | number>;
  seasons: Map<number, Array<{ number: number; watched_at: string }>>;
}

// Trakt answers 201 with a per-kind breakdown. `not_found` holds the entries it could not
// resolve to a title — those are never added, never appear in /sync/watched, and would be
// re-POSTed on every tick forever, invisibly. Everything else Trakt sends is ignored (strip).
const HistoryResult = z.object({
  not_found: z.object({
    movies: z.array(z.unknown()).nullish(),
    shows: z.array(z.unknown()).nullish(),
    seasons: z.array(z.unknown()).nullish(),
    episodes: z.array(z.unknown()).nullish()
  }).nullish()
});

/**
 * Push plays to Trakt's history. Returns the number of entries Trakt reported as `not_found`
 * (0 when everything resolved) so the caller can surface a never-converging play instead of
 * counting it as a silent success.
 */
export async function addToHistory(accessToken: string, plays: TraktPlay[]): Promise<number> {
  if (plays.length === 0) return 0;

  const movies = plays
    .filter((p) => p.mediaType === 'movie')
    .map((p) => ({ watched_at: new Date(p.watchedAt).toISOString(), ids: idsOf(p) }));

  // TV plays are grouped under the SHOW, with seasons and episodes nested. That is the shape
  // Trakt's history endpoint accepts, and it is the same shape /sync/watched/shows returns —
  // so a pushed play and the watched-set comparison agree on one key. A flat `episodes` array
  // keyed by show ids would be silently mis-synced (Trakt would mark the whole show watched).
  const shows = new Map<string, ShowEntry>();
  for (const p of plays) {
    if (p.mediaType !== 'tv' || p.season === null || p.episode === null) continue;
    // `||`, not `??`: resolveIds can store an EMPTY imdb id (a guid of literally `imdb://`
    // slices to ''), and `??` would keep that empty string as the key, dropping a play that
    // `playKey` still emits a tmdb key for — so it would be re-selected on every tick forever.
    // Both branches are namespaced so the grouping key can never confuse an imdb id for a tmdb one.
    const key = p.imdbId ? `imdb:${p.imdbId}` : (p.tmdbId !== null ? `tmdb:${p.tmdbId}` : '');
    if (key === '') continue; // unidentifiable: never synced, not an error
    let entry = shows.get(key);
    if (!entry) { entry = { ids: idsOf(p), seasons: new Map() }; shows.set(key, entry); }
    const eps = entry.seasons.get(p.season) ?? [];
    eps.push({ number: p.episode, watched_at: new Date(p.watchedAt).toISOString() });
    entry.seasons.set(p.season, eps);
  }

  const body = {
    movies,
    shows: [...shows.values()].map((s) => ({
      ids: s.ids,
      seasons: [...s.seasons.entries()].map(([number, episodes]) => ({ number, episodes }))
    }))
  };

  const res = await fetch(`${API}/sync/history`, {
    method: 'POST',
    headers: traktHeaders(accessToken),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new TraktHttpError(res.status, 'history');

  const nf = HistoryResult.parse(await res.json()).not_found;
  if (!nf) return 0;
  return (nf.movies?.length ?? 0) + (nf.shows?.length ?? 0)
    + (nf.seasons?.length ?? 0) + (nf.episodes?.length ?? 0);
}
