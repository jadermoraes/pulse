import type { DB } from '../db';
import type { Connection } from '../connections';
import { listConnections } from '../connections';
import { getJsonWithKey, joinUrl } from '../http';
import { datastoreGet, datastorePut, StremioError, type StremioLibraryItem } from '../integrations/stremio';
import { resolveImdbMeta } from '../integrations/cinemeta';
import { importWatchlist, listWatchlist, removeWatchlist } from './watchlist';
import {
  getStremioConnection, participantIds,
  recordHouseholdSuccess, recordHouseholdNote, recordHouseholdFailure
} from './household-stremio';
import { reconcile, stremioType, type PulseItem, type StremioItem, type ReconcileResult } from './stremio-reconcile';
import { listHouseholdRemovals, clearHouseholdRemovals } from './household-removals';

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

function dedupeKey(tmdbId: number, mediaType: string): string {
  return `${tmdbId}:${mediaType === 'tv' ? 'tv' : 'movie'}`;
}

/**
 * The household list is the UNION of every participant's watchlist and in-flight requests,
 * one entry per (tmdbId, mediaType) no matter how many people contributed it. From Stremio's
 * side that is one list, which is what a shared TV should show.
 *
 * Within a participant the existing rule holds: a watchlist row wins over a request row for the
 * same title (it carries on_server). Across participants, `onServer` is AND-ed. `onServer` drives
 * "drop it from the Library once it has landed", so a title one person is still waiting on must
 * stay in the list; taking the first contributor's flag, or OR-ing, would yank a title off the
 * shared TV while somebody was still queued for it.
 *
 * The participant order decides which contributor's title text is displayed. Callers pass ids in
 * a stable order so a poll cycle is deterministic.
 */
export async function loadPulseItems(
  db: DB, participants: number[], seerr: Connection | null
): Promise<PulseItem[]> {
  const merged = new Map<string, { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; onServer: boolean }>();

  for (const consumerId of participants) {
    const watchlist = listWatchlist(db, consumerId);
    const seen = new Set(watchlist.map((r) => dedupeKey(r.tmdbId, r.mediaType)));
    const rows: Array<{ tmdbId: number; mediaType: string; title: string; onServer: boolean }> = [
      ...watchlist.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, onServer: r.onServer })),
      ...inFlightRequests(db, consumerId).filter((q) => !seen.has(dedupeKey(q.tmdbId, q.mediaType)))
    ];
    for (const r of rows) {
      const mediaType = r.mediaType === 'tv' ? 'tv' : 'movie';
      const k = dedupeKey(r.tmdbId, mediaType);
      const prev = merged.get(k);
      merged.set(k, prev
        ? { ...prev, onServer: prev.onServer && r.onServer }
        : { tmdbId: r.tmdbId, mediaType, title: r.title, onServer: r.onServer });
    }
  }

  const out: PulseItem[] = [];
  for (const r of merged.values()) {
    const imdbId = await imdbForTmdb(db, seerr, r.tmdbId, r.mediaType);
    const st = db.prepare(
      `SELECT dropped_at FROM household_sync_state
        WHERE spoke='stremio' AND entity='watchlist' AND tmdb_id=? AND media_type=?`
    ).get(r.tmdbId, r.mediaType) as any;
    out.push({
      tmdbId: r.tmdbId, mediaType: r.mediaType, imdbId, title: r.title,
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

function markSynced(
  db: DB, p: Pick<PulseItem, 'tmdbId' | 'mediaType'>, dropped: number | null
): void {
  db.prepare(
    `INSERT INTO household_sync_state(spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES ('stremio','watchlist',?,?,?,?)
     ON CONFLICT(spoke,entity,tmdb_id,media_type) DO UPDATE SET
       synced_at=excluded.synced_at, dropped_at=excluded.dropped_at`
  ).run(p.tmdbId, p.mediaType, Date.now(), dropped);
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
export async function applyPull(
  db: DB, participants: number[], plan: ReconcileResult, suppressed: Set<string> = new Set()
): Promise<number> {
  let skipped = 0;
  for (const s of plan.importItems.slice(0, MAX_IMPORTS_PER_CYCLE)) {
    try {
      const type = s.type === 'series' ? 'series' : 'movie';
      const meta = await resolveImdbMeta(db, s.imdbId, type);
      if (!meta || meta.tmdbId === null) continue; // unresolvable: not an error
      const tmdbId = meta.tmdbId;
      const name = meta.name;
      const mediaType = type === 'series' ? 'tv' : 'movie';
      // A title with a pending removal must not be re-imported, even when we could not resolve its
      // imdb id upstream and so could not exclude it from the reconciler's input. `resolveImdbMeta`
      // has just given us the tmdb id the queue is keyed on, so this is the first point where the
      // two can be compared at all.
      if (suppressed.has(`${tmdbId}:${mediaType}`)) continue;
      // The fan-out and its provenance row commit together or not at all. A half-applied import
      // is the worst outcome available: the household_sync_state row makes the title "already
      // known", so the next cycle will not retry it, while some participants never received it.
      // The Cinemeta fetch is deliberately outside the transaction — better-sqlite3 transactions
      // are synchronous and must not await.
      db.transaction(() => {
        for (const consumerId of participants) {
          // importWatchlist, NOT addWatchlist: an import must never clobber a row pulse already
          // owns (its on_server flag in particular), and never arms a notify the viewer didn't
          // ask for. On a first link this loop can see a hundred titles; notify=1 would fire a
          // push AND a Telegram DM AND a Jellyfin favourite for every one of them, per person.
          importWatchlist(db, { consumerId, tmdbId, mediaType, title: name, onServer: false });
        }
        db.prepare(
          `INSERT INTO household_sync_state(spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
           VALUES ('stremio','watchlist',?,?,?,NULL)
           ON CONFLICT(spoke,entity,tmdb_id,media_type) DO UPDATE SET synced_at=excluded.synced_at`
        ).run(tmdbId, mediaType, Date.now());
      })();
    } catch {
      // one bad title never blocks the rest — matches plays-ingest's contract. A Cinemeta 5xx
      // on this id must not also stall every OTHER import and every pending delete this cycle.
      skipped++;
    }
  }

  for (const p of plan.deleteItems) {
    // Inbound removals DO fan out. The reconciler has already excluded removals pulse itself
    // performed, so this is a person deleting the title on the TV. Removing it from only some
    // participants would leave the others still contributing it to the union — pulse would push
    // it straight back and it would reappear on the TV, which is the ping-pong the reconciler's
    // dropped_at guard exists to prevent, re-introduced one level up.
    //
    // The OUTBOUND direction is deliberately NOT symmetric: a participant removing a title in
    // pulse only stops contributing it, and it leaves the TV when the last contributor drops it.
    db.transaction(() => {
      for (const consumerId of participants) removeWatchlist(db, consumerId, p.tmdbId, p.mediaType);
      db.prepare(
        `DELETE FROM household_sync_state
          WHERE spoke='stremio' AND entity='watchlist' AND tmdb_id=? AND media_type=?`
      ).run(p.tmdbId, p.mediaType);
    })();
  }

  return skipped;
}

/** Household-scoped: one Stremio account, one authKey, shared by the nominated consumers. */
export async function pollStremioSync(db: DB): Promise<void> {
  const conn = getStremioConnection(db);
  if (!conn || !conn.enabled || !conn.secret) return;

  // Sorted so the union's title choice and the push order are stable across cycles.
  const participants = participantIds(db, conn).slice().sort((a, b) => a - b);
  if (participants.length === 0) {
    // Bail BEFORE any network call. With an empty pulse list the reconciler reads the entire TV
    // Library as importable, and applyPull would stamp household_sync_state rows for titles that
    // landed on nobody — poisoning the "already known" check for whoever is added later.
    recordHouseholdNote(db, 'No pulse users are selected as participants, so nothing is being synced.');
    return;
  }

  const seerr = listConnections(db).find((c) => c.type === 'seerr' && c.enabled) ?? null;

  try {
    const library = await datastoreGet(conn.secret);
    const pulseItems = await loadPulseItems(db, participants, seerr);

    // ── Drain the household removal queue ─────────────────────────────────
    // A title a participant removed in pulse is, right now, present in the Library and absent
    // from every watchlist — which is exactly the condition the reconciler reads as "unknown to
    // pulse, import it". So these ids are handled HERE and then hidden from the reconciler
    // entirely; letting one reach it would re-import the title and undo the removal.
    //
    // This MUST run after loadPulseItems. A title can come back between the removal and this
    // poll — the same person changing their mind, or another participant re-adding it, since the
    // queue is household-wide and the window is one poll interval. If we tombstoned it anyway we
    // would put two contradictory documents for one _id into a single datastorePut, and if the
    // tombstone won, the NEXT cycle would read it as a viewer deletion and drop the row from
    // every participant.
    const wantedNow = new Set(
      pulseItems.map((p) => p.imdbId).filter((v): v is string => !!v)
    );
    const pendingRemovals = listHouseholdRemovals(db);
    const removalById = new Map(
      pendingRemovals
        .filter((r) => r.imdbId && !wantedNow.has(r.imdbId))
        .map((r) => [r.imdbId as string, r])
    );
    const excluded = new Set(removalById.keys());
    const removalChanges: StremioLibraryItem[] = [];
    for (const item of library) {
      if (!removalById.has(item._id) || item.removed) continue;
      // read-modify-write: only `removed` and `_mtime` are ours. `state` is the household's real
      // cross-device watch progress and datastorePut is a full-document replace.
      removalChanges.push({ ...item, removed: true, _mtime: new Date().toISOString() });
    }
    // Every queued row is settled this cycle — pushed, already gone from Stremio, unresolvable, or
    // superseded because somebody wants the title again. All four reach the same end state: there
    // is nothing left to do, and retrying would leak the queue. Note `settledRemovals` is built
    // from the FULL snapshot, not from removalById, so the superseded ones clear too.
    const settledRemovals = pendingRemovals.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType }));
    // Built from the FULL snapshot, not from `removalById`: a queued row with no imdb id never
    // reaches `excluded`, so the reconciler still hands its title to the import stage. Suppressing
    // by tmdb id there is the only place such a removal can be honoured at all — otherwise it is
    // actively UNDONE, re-imported into every participant on the very cycle it is settled.
    const suppressedRemovals = new Set(
      pendingRemovals.map((r) => `${r.tmdbId}:${r.mediaType}`)
    );

    const stremioItems: StremioItem[] = library
      .filter((i) => !excluded.has(i._id))
      .map((i) => ({ imdbId: i._id, type: i.type, removed: i.removed }));
    const plan = reconcile(pulseItems, stremioItems);

    const byId = new Map(library.map((i) => [i._id, i]));
    const template = library[0] ?? null;
    const changes: StremioLibraryItem[] = [...removalChanges];
    // sync_state writes are staged here and applied only once `datastorePut` below has
    // actually succeeded. Writing them eagerly means a transient datastorePut failure — a 5xx,
    // a timeout — still commits e.g. `dropped_at = NULL` for a re-pushed, still-tombstoned item;
    // the NEXT cycle then reads that premature clear and the reconciler routes the item to
    // `deleteItems`, destroying watchlist rows over nothing more than a network blip.
    const syncUpdates: Array<{ p: PulseItem; dropped: number | null }> = [];

    for (const p of plan.push) {
      // Guarded per item, in the same spirit as the import loop. `imdbForTmdb` only ever UPDATEs
      // a Cinemeta-created cache row, so a Seerr-sourced imdb id has no row and goes to the
      // network here — and `fetchCinemetaMeta` throws on any non-404 non-2xx. Unguarded, that one
      // id's 5xx escapes past datastorePut, past the sync_state drain and past applyPull.
      let meta: { name: string; poster: string | null } | null = null;
      try {
        meta = await resolveImdbMeta(db, p.imdbId!, stremioType(p.mediaType));
      } catch {
        meta = null;
      }
      // Prefer the item's OWN current shape when Stremio already has it (e.g. reviving a title
      // pulse tombstoned earlier): that item's `state` is the household's real progress, not a
      // borrowed shape, and buildLibraryItem must not zero it.
      changes.push(buildLibraryItem(p, byId.get(p.imdbId!) ?? template, meta));
      syncUpdates.push({ p, dropped: null });
    }

    for (const p of plan.remove) {
      const existing = byId.get(p.imdbId!);
      if (!existing) continue;
      // read-modify-write: only `removed` and `_mtime` are ours. Watch progress lives in `state`
      // and is synced across the household's devices — clobbering it would erase it.
      changes.push({ ...existing, removed: true, _mtime: new Date().toISOString() });
      syncUpdates.push({ p, dropped: Date.now() });
    }

    for (const p of plan.clearDropped) syncUpdates.push({ p, dropped: null });

    await datastorePut(conn.secret, changes);
    for (const { p, dropped } of syncUpdates) markSynced(db, p, dropped);
    // A queued removal is pulse removing a title from Stremio, exactly like `plan.remove` above,
    // so it needs the same provenance stamp. Without it the reconciler reads the tombstone as a
    // VIEWER deletion on the next cycle, and `deleteItems` fans a removeWatchlist out to every
    // participant — eating any re-add, forever, one poll after each attempt.
    for (const c of removalChanges) {
      const r = removalById.get(c._id as string);
      if (r) markSynced(db, { tmdbId: r.tmdbId, mediaType: r.mediaType }, Date.now());
    }
    clearHouseholdRemovals(db, settledRemovals);
    const skipped = await applyPull(db, participants, plan, suppressedRemovals);

    const notes: string[] = [];
    // The push direction is a silent no-op without Seerr: `imdbForTmdb` is the ONLY forward
    // tmdb -> imdb path, it returns null when no Seerr connection is enabled, and the reconciler
    // skips every item with a null imdb id. The pull keeps working, so the link looks healthy
    // while nothing pulse owns ever reaches Stremio. Say so out loud.
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
    const unpushableRemovals = pendingRemovals.filter((r) => !r.imdbId).length;
    if (unpushableRemovals > 0) {
      notes.push(
        `${unpushableRemovals} removed title(s) could not be taken off the Stremio Library: ` +
        'pulse has no IMDb id for them, so there is nothing to remove there.'
      );
    }
    // recordHouseholdSuccess first: the credential itself worked, so lastSyncAt must advance and
    // failCount must reset. recordHouseholdNote then leaves the caveat visible instead of letting
    // the blanket lastError=null present a cycle that dropped every import as a clean one.
    recordHouseholdSuccess(db);
    if (notes.length) recordHouseholdNote(db, notes.join(' '));
  } catch (e) {
    const message = (e as Error).message;
    // `failCount` never decays, so counting every thrown error toward MAX_FAILS would let a brief
    // Stremio 5xx, a Cinemeta hiccup, or a DNS blip permanently disable an authKey that was never
    // invalid. Two signals mean the credential itself is dead: Stremio's own error code 1 =
    // "Invalid auth", carried in a 200 body, or an HTTP 401/403 from api.strem.io directly.
    const authDead = e instanceof StremioError && (e.code === 1 || e.status === 401 || e.status === 403);
    if (authDead) {
      recordHouseholdFailure(db, message);
    } else {
      recordHouseholdNote(db, message);
    }
  }
}
