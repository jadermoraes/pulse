import type { DB } from '../db';
import type { Connection } from '../connections';
import { listConnections } from '../connections';
import { getJsonWithKey, joinUrl } from '../http';
import { datastoreGet, datastorePut, StremioError, type StremioLibraryItem } from '../integrations/stremio';
import { resolveImdbMeta } from '../integrations/cinemeta';
import { importWatchlist, listWatchlist, removeWatchlist } from './watchlist';
import { listEnabled, recordSuccess, recordFailure, recordNote } from './spoke-credentials';
import { reconcile, stremioType, type PulseItem, type StremioItem, type ReconcileResult } from './stremio-reconcile';

/** Forward tmdb -> imdb via Seerr, cached in imdb_meta_cache's row for the same pair. */
async function imdbForTmdb(
  db: DB, seerr: Connection | null, tmdbId: number, mediaType: 'movie' | 'tv'
): Promise<string | null> {
  const cacheType = mediaType === 'tv' ? 'series' : 'movie';
  const cached = db.prepare('SELECT imdb_id FROM imdb_meta_cache WHERE tmdb_id=? AND media_type=?')
    .get(tmdbId, cacheType) as any;
  if (cached?.imdb_id) return cached.imdb_id;
  if (!seerr) return null;
  try {
    const path = mediaType === 'tv' ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
    const d = await getJsonWithKey(joinUrl(seerr.baseUrl, path), seerr.secret);
    const imdb: string | null = d?.externalIds?.imdbId ?? d?.imdbId ?? null;
    if (imdb) {
      // Only ever backfill the tmdb_id column of a row Cinemeta itself already created — never
      // touch found/name/poster here. This is deliberately NOT an upsert: inserting a row for a
      // (imdb_id, media_type) pair that Cinemeta hasn't resolved yet — even with found=0 — would
      // sit at the exact primary key `resolveImdbMeta` reads, and its cache check treats ANY
      // existing row as a permanent answer (found=0 is how a real Cinemeta negative is cached
      // forever). That would block resolveImdbMeta's OWN fetch for this id and permanently ship
      // the item with no name/poster — the very bug this function must not reintroduce.
      db.prepare('UPDATE imdb_meta_cache SET tmdb_id=? WHERE imdb_id=? AND media_type=?')
        .run(tmdbId, imdb, cacheType);
    }
    return imdb;
  } catch {
    return null;
  }
}

/**
 * Spec: the Library shows "wanted + in-flight, drop when available". So the push set is the
 * UNION of watchlist rows and the viewer's requests, deduplicated on (tmdbId, mediaType) with
 * the watchlist row winning (it carries on_server).
 *
 * `available` is included on purpose even though such a request is no longer in flight. A
 * request that silently LEAVES this set the moment Seerr flips it never reaches the reconciler
 * at all, so the "drop when available" half of the contract never runs: the title stays in the
 * viewer's Stremio Library forever, and — being absent from pulse's view — the pull direction
 * reads it back as a title the viewer saved by hand and re-imports it. Keeping it here with
 * `onServer: true` routes it to `remove`, which is exactly what the spec asks for.
 *
 * `consumer_requests` has no unique constraint on (consumer_id, tmdb_id, media_type) — a viewer
 * re-requesting a title they already have ends up with two rows for it (e.g. one 'available',
 * one still 'pending'), and `createRequest` inserts unconditionally. Left ungrouped, that used to
 * hand back two PulseItems with the same imdbId and contradictory `onServer` flags sharing one
 * sync_state row (`markSynced` keys on tmdb_id+media_type only): one pushed while the other
 * removed, forever, a real Stremio write every poll tick. So this groups by (tmdb_id,
 * media_type) and derives one `onServer` per title: true only when EVERY row for it is
 * 'available' (`MIN(status='available')` is 1 only when no row disagrees), matching the
 * "still-wanted if anything is still in flight, landed only once everything is" semantics.
 */
function inFlightRequests(
  db: DB, consumerId: number
): Array<{ tmdbId: number; mediaType: string; title: string; onServer: boolean }> {
  const rows = db.prepare(
    `SELECT tmdb_id AS tmdbId, media_type AS mediaType, MIN(title) AS title,
            MIN(status = 'available') AS allAvailable
       FROM consumer_requests
      WHERE consumer_id=? AND status IN ('pending','processing','available')
      GROUP BY tmdb_id, media_type`
  ).all(consumerId) as any[];
  return rows.map((r) => ({
    tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, onServer: !!r.allAvailable
  }));
}

export async function loadPulseItems(
  db: DB, consumerId: number, seerr: Connection | null
): Promise<PulseItem[]> {
  const watchlist = listWatchlist(db, consumerId);
  const seen = new Set(watchlist.map((r) => `${r.tmdbId}:${r.mediaType === 'tv' ? 'tv' : 'movie'}`));
  const rows: Array<{ tmdbId: number; mediaType: string; title: string; onServer: boolean }> = [
    ...watchlist.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, onServer: r.onServer })),
    ...inFlightRequests(db, consumerId)
      .filter((q) => !seen.has(`${q.tmdbId}:${q.mediaType === 'tv' ? 'tv' : 'movie'}`))
      .map((q) => ({ tmdbId: q.tmdbId, mediaType: q.mediaType, title: q.title, onServer: q.onServer }))
  ];
  const out: PulseItem[] = [];
  for (const r of rows) {
    const mediaType = r.mediaType === 'tv' ? 'tv' : 'movie';
    const imdbId = await imdbForTmdb(db, seerr, r.tmdbId, mediaType);
    const st = db.prepare(
      `SELECT dropped_at FROM sync_state
        WHERE consumer_id=? AND spoke='stremio' AND entity='watchlist' AND tmdb_id=? AND media_type=?`
    ).get(consumerId, r.tmdbId, mediaType) as any;
    out.push({
      tmdbId: r.tmdbId, mediaType, imdbId, title: r.title,
      onServer: r.onServer, droppedAt: st?.dropped_at ?? null
    });
  }
  return out;
}

/** Keys `buildLibraryItem` sets itself; everything else in a borrowed template is another
 *  title's data and must be emptied rather than inherited. */
const OWNED_KEYS = new Set(['_id', 'name', 'type', 'poster', 'removed', 'temp', '_ctime', '_mtime', 'state']);

/** Keep the key, drop the value: same type, no content borrowed from the template. */
function blankValue(v: unknown): unknown {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return null;
  if (typeof v === 'boolean') return false;
  if (Array.isArray(v)) return [];
  if (v !== null && typeof v === 'object') return {};
  return v; // null / undefined are already empty
}

/**
 * Build the item pulse writes. The exact payload Stremio accepts for a NEW libraryItem is
 * undocumented, so when the viewer already has items we copy one's field shape verbatim and
 * change only what pulse owns — rather than inventing a structure and hoping.
 *
 * Two different situations share this one function:
 *  - REVIVING the viewer's own item (`template._id` already equals what we're building, i.e.
 *    it's the same title, just tombstoned): `state` is the viewer's real, accumulated progress
 *    on THIS title — carried through completely unchanged, and `_ctime` is kept too, since this
 *    is not a new creation.
 *  - CREATING an item that borrows another title's field shape (template is `null`, or belongs
 *    to a different id used only to learn what keys Stremio expects): we want the borrowed
 *    item's KEYS and none of its VALUES. Copying the template and overriding only the keys we
 *    know about is not enough — a real Stremio item also carries `background`, `logo`, `year`,
 *    `released`, `description`, `runtime`, `posterShape`, `behaviorHints`… and the newly pushed
 *    title would arrive wearing another movie's artwork, year and description. So EVERY key we
 *    do not own is reset by type, exactly as `state` is, and by type rather than by assuming a
 *    number: a string like `watched` or `lastWatched` must not survive either, and an object or
 *    array must not survive BY REFERENCE (a shared reference is the same leak, plus aliasing).
 */
export function buildLibraryItem(
  p: PulseItem,
  template: StremioLibraryItem | null,
  meta: { name: string; poster: string | null } | null
): StremioLibraryItem {
  const now = new Date().toISOString();
  const reviving = !!template && template._id === p.imdbId;

  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template ?? {})) {
    if (OWNED_KEYS.has(k)) continue;
    base[k] = reviving ? v : blankValue(v);
  }

  let state: Record<string, unknown>;
  if (reviving) {
    state = template?.state ? { ...template.state } : {};
  } else {
    state = {};
    for (const [k, v] of Object.entries(template?.state ?? {})) state[k] = blankValue(v);
  }

  return {
    ...base,
    _id: p.imdbId!,
    // On the revive path the template IS this title, so its own name/poster are real viewer-facing
    // data: a Cinemeta miss (404, or a fetch we had to swallow) must not blank them.
    name: meta?.name ?? (reviving ? ((template!.name as string | null) ?? p.title) : p.title),
    type: stremioType(p.mediaType),
    poster: meta?.poster ?? (reviving ? (template!.poster ?? null) : null),
    removed: false,
    temp: false,
    _ctime: reviving ? (template!._ctime ?? now) : now,
    _mtime: now,
    state
  } as StremioLibraryItem;
}

function markSynced(db: DB, consumerId: number, p: PulseItem, dropped: number | null): void {
  db.prepare(
    `INSERT INTO sync_state(consumer_id,spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES (?,'stremio','watchlist',?,?,?,?)
     ON CONFLICT(consumer_id,spoke,entity,tmdb_id,media_type) DO UPDATE SET
       synced_at=excluded.synced_at, dropped_at=excluded.dropped_at`
  ).run(consumerId, p.tmdbId, p.mediaType, Date.now(), dropped);
}

/**
 * How many Stremio-saved titles a single cycle may import.
 *
 * On a FIRST link nothing is known, so every item in the viewer's Library is an import candidate
 * — a hundred of them is ordinary. Each one is a sequential, uncached Cinemeta fetch inside the
 * poller's `_running` guard, so an unbounded loop holds the whole event tick (pollTraktHistory,
 * pruneEvents…) hostage for minutes. The leftovers are not lost: they are still absent from
 * pulse next cycle, so they import then, a bounded batch at a time.
 */
export const MAX_IMPORTS_PER_CYCLE = 25;

/**
 * Pull stage. An import needs a tmdb id, which Cinemeta supplies from the imdb id Stremio keys
 * on; an id Cinemeta cannot resolve is skipped rather than guessed at. A hand-removal deletes
 * the pulse row — the reconciler has already excluded removals pulse itself performed.
 *
 * Returns how many imports were dropped by an ERROR (not by a clean "Cinemeta doesn't know this
 * id", which is a legitimate outcome). A cycle that silently dropped every import used to be
 * indistinguishable from a clean one — `recordSuccess` wiped `last_error` either way — so the
 * caller needs this to tell the two apart.
 */
export async function applyPull(db: DB, consumerId: number, plan: ReconcileResult): Promise<number> {
  let skipped = 0;
  for (const s of plan.importItems.slice(0, MAX_IMPORTS_PER_CYCLE)) {
    try {
      const type = s.type === 'series' ? 'series' : 'movie';
      const meta = await resolveImdbMeta(db, s.imdbId, type);
      if (!meta || meta.tmdbId === null) continue; // unresolvable: not an error
      const mediaType = type === 'series' ? 'tv' : 'movie';
      // importWatchlist, NOT addWatchlist: an import must never clobber a row pulse already owns
      // (its on_server flag in particular), and never arms a notify the viewer didn't ask for.
      importWatchlist(db, {
        consumerId, tmdbId: meta.tmdbId, mediaType, title: meta.name, onServer: false
      });
      db.prepare(
        `INSERT INTO sync_state(consumer_id,spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
         VALUES (?,'stremio','watchlist',?,?,?,NULL)
         ON CONFLICT(consumer_id,spoke,entity,tmdb_id,media_type) DO UPDATE SET synced_at=excluded.synced_at`
      ).run(consumerId, meta.tmdbId, mediaType, Date.now());
    } catch {
      // one bad title never blocks the rest — matches plays-ingest's contract. A Cinemeta 5xx
      // on this id must not also stall every OTHER import and every pending delete this cycle.
      skipped++;
    }
  }

  for (const p of plan.deleteItems) {
    removeWatchlist(db, consumerId, p.tmdbId, p.mediaType);
    db.prepare(
      `DELETE FROM sync_state
        WHERE consumer_id=? AND spoke='stremio' AND entity='watchlist' AND tmdb_id=? AND media_type=?`
    ).run(consumerId, p.tmdbId, p.mediaType);
  }

  return skipped;
}

/** Push stage. Per-consumer isolated: one broken authKey never stalls another viewer. */
export async function pollStremioSync(db: DB): Promise<void> {
  const seerr = listConnections(db).find((c) => c.type === 'seerr' && c.enabled) ?? null;

  for (const cred of listEnabled(db, 'stremio')) {
    try {
      const library = await datastoreGet(cred.secret);
      const stremioItems: StremioItem[] = library.map((i) => ({
        imdbId: i._id, type: i.type, removed: i.removed
      }));
      const pulseItems = await loadPulseItems(db, cred.consumerId, seerr);
      const plan = reconcile(pulseItems, stremioItems);

      const byId = new Map(library.map((i) => [i._id, i]));
      const template = library[0] ?? null;
      const changes: StremioLibraryItem[] = [];
      // sync_state writes are staged here and applied only once `datastorePut` below has
      // actually succeeded. Writing them eagerly (as this loop used to) means a transient
      // datastorePut failure — a 5xx, a timeout — still commits e.g. `dropped_at = NULL` for a
      // re-pushed, still-tombstoned item; the NEXT cycle then reads that premature clear and the
      // reconciler routes the item to `deleteItems`, destroying the viewer's watchlist row over
      // nothing more than a network blip. `clearDropped` is the only path meant to clear the
      // stamp on its own steam (it does so only once Stremio itself confirms the item present).
      const syncUpdates: Array<{ p: PulseItem; dropped: number | null }> = [];

      for (const p of plan.push) {
        // Guarded per item, in the same spirit as the import loop. `imdbForTmdb` only ever
        // UPDATEs a Cinemeta-created cache row, so a Seerr-sourced imdb id has no row and goes to
        // the network here — and `fetchCinemetaMeta` throws on any non-404 non-2xx. Unguarded,
        // that one id's 5xx escapes past datastorePut, past the sync_state drain and past
        // applyPull, aborting every other push, every pending delete and every import for this
        // consumer, every cycle, for as long as Cinemeta dislikes it. buildLibraryItem already
        // handles `meta === null`, so pushing without metadata is a legal fallback.
        let meta: { name: string; poster: string | null } | null = null;
        try {
          meta = await resolveImdbMeta(db, p.imdbId!, stremioType(p.mediaType));
        } catch {
          meta = null;
        }
        // Prefer the item's OWN current shape when Stremio already has it (e.g. reviving a
        // title pulse tombstoned earlier): that item's `state` is the viewer's real progress,
        // not a borrowed shape, and buildLibraryItem must not zero it. Only fall back to an
        // unrelated item's shape when this id is genuinely new to the library.
        changes.push(buildLibraryItem(p, byId.get(p.imdbId!) ?? template, meta));
        syncUpdates.push({ p, dropped: null });
      }

      for (const p of plan.remove) {
        const existing = byId.get(p.imdbId!);
        if (!existing) continue;
        // read-modify-write: only `removed` and `_mtime` are ours. Watch progress lives in
        // `state` and is synced across the viewer's devices — clobbering it would erase it.
        changes.push({ ...existing, removed: true, _mtime: new Date().toISOString() });
        syncUpdates.push({ p, dropped: Date.now() });
      }

      for (const p of plan.clearDropped) syncUpdates.push({ p, dropped: null });

      await datastorePut(cred.secret, changes);
      for (const { p, dropped } of syncUpdates) markSynced(db, cred.consumerId, p, dropped);
      const skipped = await applyPull(db, cred.consumerId, plan);

      const notes: string[] = [];
      // The push direction is a silent no-op without Seerr: `imdbForTmdb` is the ONLY forward
      // tmdb -> imdb path, it returns null when no Seerr connection is enabled, and the
      // reconciler skips every item with a null imdb id. The pull keeps working, so the link
      // looks healthy while nothing pulse owns ever reaches Stremio. Say so out loud.
      const unresolved = pulseItems.filter((p) => p.imdbId === null).length;
      if (plan.push.length === 0 && unresolved > 0 && !seerr) {
        notes.push(
          `${unresolved} title(s) could not be pushed to Stremio: matching a pulse title to an ` +
          'IMDb id needs an enabled Seerr connection, and none is configured.'
        );
      }
      if (skipped > 0) {
        notes.push(`${skipped} title(s) saved in Stremio could not be imported this cycle (metadata lookup failed).`);
      }
      // recordSuccess first: the credential itself worked (datastoreGet and datastorePut both
      // succeeded), so last_sync_at must advance and fail_count must reset. recordNote then
      // leaves the caveat visible instead of letting recordSuccess's blanket last_error=NULL
      // present a cycle that dropped every import as a clean one.
      recordSuccess(db, cred.consumerId, 'stremio');
      if (notes.length) recordNote(db, cred.consumerId, 'stremio', notes.join(' '));
    } catch (e) {
      const message = (e as Error).message;
      // `fail_count` never decays, so counting every thrown error toward MAX_FAILS would let a
      // brief Stremio 5xx, a Cinemeta hiccup, or a DNS blip (recoverable, ~5 ticks = ~10 min)
      // permanently disable an authKey that was never actually invalid. Two signals mean the
      // credential itself is genuinely dead: Stremio's own error code 1 = "Invalid auth" (see
      // integrations/stremio.test.ts), carried in a 200 body, or an HTTP 401/403 from
      // api.strem.io directly (mirrors trakt-sync.ts treating both statuses as fatal). Anything
      // else is merely noted.
      const authDead = e instanceof StremioError && (e.code === 1 || e.status === 401 || e.status === 403);
      if (authDead) {
        recordFailure(db, cred.consumerId, 'stremio', message);
      } else {
        recordNote(db, cred.consumerId, 'stremio', message);
      }
    }
  }
}
