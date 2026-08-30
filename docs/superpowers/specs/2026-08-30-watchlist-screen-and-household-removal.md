# Watchlist Screen and Household Removal — Design

**Date:** 2026-08-30
**Status:** Approved in conversation.
**Builds on:** `2026-08-29-household-stremio-design.md` (shipped and deployed 2026-08-29).

## Problem

Two problems, one of which only became visible once the household Stremio sync went live.

**1. The watchlist has no screen.** `consumer_watchlist` has had server code, an agent tool
(`watchlistList`/`watchlistAdd`/`watchlistRemove`) and a `watchlist` capability since before this
work. It has never had a UI. That was tolerable when the list held a handful of rows someone added
deliberately; it is not now — the household sync imported ~78 titles from the TV into every
participant, and there is nowhere in the app to look at them. The only ways to see the list today
are the Stremio Library on the TV, or asking the chat.

**2. Removing a title in pulse does not work, and never did.** This is a defect in the shipped
sync, not a missing feature.

`stremio-reconcile.ts` decides imports with one line:

```ts
const importItems = stremioItems.filter((s) => !s.removed && !knownImdb.has(s.imdbId));
```

Anything present in the Stremio Library that pulse does not know about is imported. So a title
removed from every participant's watchlist is, by the next poll, exactly that: present in Stremio,
unknown to pulse. It is re-imported within one cycle. **No code path anywhere pushes
`removed: true` because a participant dropped a title in pulse.**

`2026-08-29-household-stremio-design.md` claims the opposite — its table says *"A participant
removes a title in pulse → it leaves the shared list once no participant still wants it, and then
leaves the TV"*. The first half is true (the union shrinks); the second half never happened. That
spec is corrected as part of this work.

The bug is live today: `watchlistRemove` is already reachable through the chat, and a title removed
that way comes back on the next poll.

## Decisions taken

- **Removal is household-wide.** Removing a title removes it for every participant and pulls it off
  the TV. There is no per-viewer removal variant. The owner chose this explicitly: a shared
  living-room list where one person's list can silently differ from another's is not worth the
  complexity.
- **This is compatible with the union semantics the sync already has.** Those govern *implicit*
  removal — a title leaving one person's list as a side effect. This is an *explicit* destructive
  action a person took on a list they know is shared. Different things; the union rule stands.
- **One flat list, newest first.** Not split by "on server vs wanted", not by provenance.
- **Not a sixth nav tab.** Five destinations already sit at `flex: 1` with 10.5px labels on mobile;
  a sixth shrinks all of them. Watchlist becomes a second view on the existing Requests page.

## Model: a removal queue, not a tombstone

Deleting the pulse rows is not enough — that is precisely the state that triggers a re-import. The
title must be tombstoned in **Stremio**, and until that write lands the title must be invisible to
the reconciler.

A new table, created with `CREATE TABLE IF NOT EXISTS` because `migrate()` has no `ALTER` path and
is uncaught in `getDb()`:

```sql
CREATE TABLE IF NOT EXISTS household_removals (
  spoke       TEXT NOT NULL,
  tmdb_id     INTEGER NOT NULL,
  media_type  TEXT NOT NULL,
  imdb_id     TEXT,
  removed_at  INTEGER NOT NULL,
  PRIMARY KEY (spoke, tmdb_id, media_type)
);
```

`imdb_id` is nullable and resolved at enqueue time from `imdb_meta_cache` — the row is the only
place the mapping survives once the watchlist rows are gone, and re-resolving it later needs Seerr.
A row whose `imdb_id` is null cannot be pushed, and cannot be excluded from the reconciler's input
either — that input is keyed on imdb id, so there is nothing to match on. It is instead suppressed
one stage later, in the import loop, where `resolveImdbMeta` has just produced the tmdb id the queue
is keyed on: that is the first and only point where the two can be compared. Without that second
gate such a removal is not merely unpushable but actively undone — the title is re-imported into
every participant on the same cycle the queue row is dropped. The row is still dropped after the
pass rather than retried forever, and the household note says the title could not be taken off the
Stremio Library.

**The flow:**

1. **On remove** — one transaction: delete the title from every participant's `consumer_watchlist`,
   and insert one `household_removals` row stamped with the resolved imdb id.
2. **On the next poll**, before reconciling: read the pending removals; build `removed: true`
   documents for those present and not-yet-removed in the Library (read-modify-write, so the
   viewer's `state` — cross-device watch progress — survives); and **exclude those imdb ids from the
   `stremioItems` list handed to the reconciler**.
3. That exclusion is the whole trick. The reconciler never sees the title, so it cannot classify it
   as unknown-and-importable.
4. **After `datastorePut` succeeds**, delete the queue rows.

The queue is transient. Once Stremio holds `removed: true`, the reconciler's own `!s.removed`
filter keeps ignoring the title unaided — and if someone re-saves it on the TV later, it imports
again exactly as a new title would. That is the desired behaviour, and it falls out rather than
needing a permanent tombstone.

**`stremio-reconcile.ts` is not modified.** Again. It takes two lists; deciding what belongs in
those lists is the orchestrator's job, and that is where Stremio-specific knowledge already lives.

## Failure handling

Unchanged in kind from the shipped sync. If `datastorePut` fails, the queue rows survive and retry
next cycle. The title is already gone from every participant's list, and cannot be re-imported
because the queue still excludes it. There is no window in which a failed write resurrects a title.

If the household connection is absent, disabled, or the viewer is not a participant, removal is
purely local: delete the row, enqueue nothing. That is also the whole behaviour for non-participants
(invites), with no special-casing.

## The screen

`/app/watchlist`, reachable as a segmented toggle at the top of `/app/requests` — one destination,
two views, no new nav entry. Client-side fetch on mount, matching every other consumer page (there
is no `+page.server.ts` under `/app`).

Per row, mirroring the Requests page's inline card markup rather than `PosterTile` (which is a
124px strip tile, wrong for a vertical list): 52px poster, title, an on-server / wanted badge, and
a remove button. `consumer_watchlist` stores no poster, so posters hydrate lazily per row via
`GET /api/app/detail?tmdbId=&mediaType=` — the identical pattern the Requests page already uses for
the identical reason.

Removal confirms once, inline on the button ("Remove for everyone?"), not in a modal. It is
destructive, shared, and visible on the TV; it should not be a single unguarded tap.

## Endpoints

`GET /api/app/watchlist` and `DELETE /api/app/watchlist`, following the 9-line
`/api/app/requests/+server.ts` template.

Both check `if (!locals.consumer) throw error(401, 'Unauthorized')` **and** the `watchlist`
capability via `effectiveAllowList(getConsumer(db, id), getRole(db, roleId))`. No REST endpoint in
the app gates on a capability today — gating lives only in the agent tool layer — so this is the
first, and it is deliberate: the capability already exists and already governs the same operations
through chat. Leaving REST ungated would make the capability a fiction.

`GET` projects `consumerId` away. `DELETE` mirrors the side effect the chat tool performs, or the
two paths diverge: `mirrorFavorite(db, consumerId, tmdbId, mediaType, false)` when the removed row
carried a `jellyfinItemId`. Per participant, since Jellyfin favourites are per-user.

## Corrections to the previous spec

`2026-08-29-household-stremio-design.md`'s event table is amended: the row claiming a pulse-side
removal reaches the TV is replaced with an accurate description plus a pointer here. The union
reasoning in that document stands unchanged and was not the error.

## Out of scope

- Adding to the watchlist from this screen (Discover already does that).
- Editing `notify_on_available` per row.
- Reordering, filtering, or search — the list is ~80 rows and flat.
- Any change to `stremio-reconcile.ts`.
