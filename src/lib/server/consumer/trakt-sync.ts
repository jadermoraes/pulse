import type { DB } from '../db';
import {
  getWatchedIds, addToHistory, playKey, refreshToken, traktConfigured,
  TraktHttpError, type TraktPlay
} from '../integrations/trakt';
import {
  listEnabled, saveCredential, recordSuccess, recordFailure, recordNote
} from './spoke-credentials';

/**
 * History sync is a GAP-FILLER. Trakt's scrobble endpoint already writes history when a play
 * completes, so pushing every stored play would duplicate. Only plays Trakt does not already
 * have are pushed — which is exactly what this is for: plays from while pulse was down, or
 * from before the account was linked.
 */
export function selectUnsynced(existing: Set<string>, plays: TraktPlay[]): TraktPlay[] {
  return plays.filter((p) => !playKey(p).some((k) => existing.has(k)));
}

/**
 * TV plays with no season/episode can never converge: `playKey` emits a suffix-less
 * `tmdb:<id>` for them, which no `getWatchedIds('shows')` key (always season/episode-suffixed)
 * can ever match, so `selectUnsynced` would keep them forever while `addToHistory` silently
 * drops them (season === null). Excluding them here means they are never selected in the
 * first place, rather than posted as an empty no-op on every tick, forever.
 */
function playsFor(db: DB, consumerId: number): TraktPlay[] {
  return (db.prepare(
    'SELECT tmdb_id, imdb_id, media_type, season, episode, watched_at FROM watch_plays WHERE consumer_id=? ORDER BY watched_at'
  ).all(consumerId) as any[])
    .filter((r) => r.media_type !== 'tv' || (r.season !== null && r.episode !== null))
    .map((r) => ({
      tmdbId: r.tmdb_id ?? null,
      imdbId: r.imdb_id ?? null,
      mediaType: r.media_type === 'tv' ? 'tv' : 'movie',
      season: r.season ?? null,
      episode: r.episode ?? null,
      watchedAt: r.watched_at
    }));
}

/** True when this consumer has at least one stored play newer than `sinceMs`. */
function hasNewPlaySince(db: DB, consumerId: number, sinceMs: number): boolean {
  return !!db.prepare('SELECT 1 FROM watch_plays WHERE consumer_id=? AND watched_at > ? LIMIT 1')
    .get(consumerId, sinceMs);
}

/** Push each linked consumer's missing plays to Trakt. Per-consumer isolated: one bad token never stalls the others. */
export async function pollTraktHistory(db: DB): Promise<void> {
  // Without client credentials every Trakt call is unauthenticated: `refreshToken` would post
  // an empty client_id, take a 401, and five ticks later disable a credential that was fine.
  // If the env is cleared the feature is simply inert, not self-destructive.
  if (!traktConfigured()) return;

  for (const cred of listEnabled(db, 'trakt')) {
    try {
      // Skip entirely — no token refresh, no network call — when nothing has changed since the
      // last successful sync. `/sync/watched/shows` returns the account's ENTIRE episode-level
      // history; fetching and rebuilding that set on every 120s tick regardless of whether
      // there's anything new would be ~720 needless large requests/day/consumer against a
      // third-party API with rate limits. `cred.lastSyncAt === null` means "never synced" (e.g.
      // credential just linked, or its first tick after being saved) and must always run.
      //
      // Known narrow limitation: a gap-filled play whose watched_at predates lastSyncAt (e.g.
      // backfilled from an old Tautulli export after a first sync already ran) could be skipped
      // until some genuinely new play triggers the next fetch. Acceptable — historical backfill
      // is already descoped from this plan.
      if (cred.lastSyncAt !== null && !hasNewPlaySince(db, cred.consumerId, cred.lastSyncAt)) {
        continue;
      }

      let accessToken = cred.secret;

      if (cred.expiresAt !== null && cred.expiresAt <= Date.now()) {
        if (!cred.refresh) throw new Error('token expired and no refresh token');
        const t = await refreshToken(cred.refresh);
        saveCredential(db, {
          consumerId: cred.consumerId, spoke: 'trakt',
          secret: t.accessToken, refresh: t.refreshToken, expiresAt: t.expiresAt
        });
        accessToken = t.accessToken;
      }

      const plays = playsFor(db, cred.consumerId);
      if (plays.length === 0) { recordSuccess(db, cred.consumerId, 'trakt'); continue; }

      const [movies, shows] = await Promise.all([
        getWatchedIds(accessToken, 'movies'),
        getWatchedIds(accessToken, 'shows')
      ]);
      const existing = new Set<string>([...movies, ...shows]);

      const notFound = await addToHistory(accessToken, selectUnsynced(existing, plays));
      recordSuccess(db, cred.consumerId, 'trakt');

      // A play Trakt cannot resolve to a title is never added and never shows up in the watched
      // set, so it is re-POSTed on every tick forever. Not a sync failure — but it must be
      // visible rather than counted as a clean success, so it lands on last_error.
      if (notFound > 0) {
        recordNote(db, cred.consumerId, 'trakt', `${notFound} play(s) not found on Trakt`);
      }
    } catch (e) {
      // Only an auth failure means the credential is genuinely dead and relinking is the fix.
      // Network errors, 429s and 5xx are transient: recording them without incrementing
      // fail_count keeps a brief Trakt outage from permanently disabling a working link.
      const status = e instanceof TraktHttpError ? e.status : null;
      const message = (e as Error).message;
      if (status === 401 || status === 403) {
        recordFailure(db, cred.consumerId, 'trakt', message);
      } else {
        recordNote(db, cred.consumerId, 'trakt', message);
      }
    }
  }
}
