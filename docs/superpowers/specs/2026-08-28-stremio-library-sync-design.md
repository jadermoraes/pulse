# Stremio Library Sync — Design

**Date:** 2026-08-28
**Status:** Approved design; both open questions verified 2026-08-28; planned in `docs/superpowers/plans/2026-08-28-stremio-watchlist-sync.md`
**Scope:** Two-way sync between a consumer's pulse watchlist and their Stremio Library, shipped in two stages (push first, then pull).

> **Superseded in part by `2026-08-28-sync-hub-design.md`.** That document generalizes this one
> into a hub-and-spoke design with Trakt as a second spoke. Still authoritative here: the
> `api.strem.io` API details, the linking flow, and the reconciler contract. **Changed there:**
> Decision 3 narrows (pulse now writes playback progress, under a monotonic rule), and
> `consumer_stremio` / the per-row sync columns are replaced by `spoke_credentials` / `sync_state`.

## Problem

Pulse already tracks what a viewer wants to watch (`consumer_watchlist`) and drives acquisition
through Seerr/Radarr/Sonarr. Stremio is where the viewer actually browses — on the desktop and on
the TV. Today the two are disconnected: a title requested on pulse is invisible in Stremio, and a
title saved in Stremio is invisible to pulse.

The goal is that the Stremio **Library tab** becomes the shared surface: things you still owe
yourself appear there, and things you save there come back to pulse so you can request them.

## What already exists (do not rebuild)

- `consumer_watchlist` table + `lib/server/consumer/watchlist.ts` — full CRUD
  (`addWatchlist`, `listWatchlist`, `removeWatchlist`, `markOnServer`, `listPendingNotify`,
  `consumersAwaiting`), keyed `(consumer_id, tmdb_id, media_type)`, with `on_server` and
  `notify_on_available`.
- Agent tools `watchlistAdd` / `watchlistList` / `watchlistRemove` (`lib/server/agent/tools.ts:310`).
  These are currently the *only* way to mutate the watchlist — there is no HTTP route for it.
- `pollWatchlistAvailability` (`lib/server/agent/events.ts:232`) — the background loop that flips
  rows to `on_server` and mirrors them into Jellyfin Favorites (`consumer/jellyfin-favorite.ts`).
  **Stremio sync is a second instance of this existing mirror pattern.**
- `startEventPoller` (`lib/server/agent/events.ts:273`) — 120s default interval
  (`PULSE_EVENT_POLL_MS`), non-overlapping tick guard, `PULSE_DISABLE_POLLER=1` kill switch.
- TMDB → IMDb mapping: Seerr's `/api/v1/movie/{tmdbId}` response carries `imdbId`, already read at
  `lib/server/integrations/seerr.ts:265`.
- Encrypted secret storage (`lib/server/crypto.ts`), consumer capabilities
  (`lib/server/identity/types.ts`), rate limiting (`lib/server/request-limit.ts`),
  access logging (`access_events` + `logAccess`).

## External API (unofficial)

Stremio's Library lives in Stremio's cloud datastore, not in the addon system. **An addon cannot
write to the Library** — addons only serve catalogs, which surface under Discover/Board. Therefore
this feature requires no addon, no manifest, and no inbound hosting; it is outbound server-to-server.

- `POST https://api.strem.io/api/datastorePut` — `{ authKey, collection: "libraryItem", changes: [...] }`
- `POST https://api.strem.io/api/datastoreGet` — reads the collection back
- Library items are keyed by **IMDb `tt` ids** (Cinemeta convention), not TMDB ids.
- Item fields: `_id`, `name`, `type`, `poster`, `_ctime`, `_mtime`, `state` (watch progress),
  and flags `removed`, `temp`, `no_notif`.
- Removal is a **flag** (`removed: true`) with the item retained, not a hard delete.

This API is undocumented and carries no stability promise. Every design decision below assumes it
can change or disappear without notice.

### Verified before implementation (2026-08-28, probed against the live services)

1. **`authKey` comes from a real login endpoint.** `POST https://api.strem.io/api/login` with
   `{ email, password, type: "Login" }` returns a structured JSON response; a deliberately-bad
   probe returned `{"error":{"code":2,"message":"User not found","wrongEmail":true}}`. Linking is
   therefore a form in the consumer app, not a copy-the-key-from-devtools chore. The password is
   used once and never persisted.
2. **The reverse imdb → tmdb lookup does not need Seerr or a TMDB key.** Cinemeta — Stremio's own
   metadata addon — answers it for free and unauthenticated:
   `GET https://v3-cinemeta.strem.io/meta/movie/tt0111161.json` returns
   `{ meta: { imdb_id: "tt0111161", moviedb_id: 278, name, year, type, ... } }`. Use
   `/meta/series/<tt-id>.json` for shows. This is the right source by construction: it is the same
   catalogue Stremio itself resolves against.

Forward tmdb → imdb still comes from Seerr (`integrations/seerr.ts:265`), which is already wired.

## Decisions

Three decisions carry the design. Each exists to prevent a specific, identified failure.

### Decision 1 — Removals are flags, not deletions

Pulse pushes `removed: true` rather than deleting, and reads the same flag to detect the viewer's
hand-removals. This matches Stremio's own semantics and survives its client sync.

### Decision 2 — Pulse never deletes its own row when a title becomes available

Policy is "drop when available": once a title is on the server, it leaves the Stremio Library
(the viewer would watch it in Plex/Jellyfin anyway). That removal happens **in Stremio only**.
The `consumer_watchlist` row stays, stamped with `stremio_dropped_at`.

Without this, the two directions ping-pong: pulse drops the item → the viewer re-adds it on the TV
→ the pull imports it → it is already `on_server` → pulse drops it again, forever. Retaining the
pulse row makes the import step a no-op and breaks the loop.

### Decision 3 — Pushes read-modify-write, never blind-put

A library item's `state` object holds **watch progress**, synced across all the viewer's devices.
A bare put would wipe it. The push path therefore takes the item returned by `datastoreGet`,
modifies only the fields pulse owns (`removed`, `_mtime`, and item identity on creation), and
writes that back. Everything else is preserved verbatim.

## Architecture

Three new modules, split so the dangerous logic is testable without touching the unofficial API.

| Module | Responsibility | Depends on |
|---|---|---|
| `lib/server/integrations/stremio.ts` | Thin API client: `login()`, `datastoreGet()`, `datastorePut()`. No business logic. | `http.ts`, `zod` |
| `lib/server/consumer/stremio-link.ts` | Per-consumer credential CRUD, encrypted. | `crypto.ts`, `db.ts` |
| `lib/server/consumer/stremio-sync.ts` | `reconcile()` — **pure function**, no network, no DB. Plus the thin orchestrator that applies its output. | the two above, `watchlist.ts`, `seerr.ts` |

The reconciler split is the point of the architecture: the removal guard is where this feature can
silently destroy a viewer's watchlist, so it must be provable by unit test rather than observed in
production.

## Data model

New table:

```sql
CREATE TABLE IF NOT EXISTS consumer_stremio (
  consumer_id   INTEGER PRIMARY KEY REFERENCES consumer_users(id) ON DELETE CASCADE,
  auth_key      TEXT NOT NULL,              -- encrypted via crypto.ts
  stremio_email TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  last_sync_at  INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL
);
```

A separate table rather than columns on `consumer_users`: that table holds identity
(`plex_account_id`, `jellyfin_user_id`, `seerr_user_id`), never secrets.

New columns on `consumer_watchlist`:

| Column | Meaning |
|---|---|
| `imdb_id TEXT` | Cached `tt` id. A row that cannot resolve one never syncs. |
| `stremio_synced_at INTEGER` | Last time pulse pushed this row as present. |
| `stremio_dropped_at INTEGER` | Set **only** when pulse itself removed the item. Never set by a viewer action. |

## Reconciler contract

```
reconcile(pulseRows, stremioItems) -> { push[], remove[], import[], delete[] }
```

| Condition | Action |
|---|---|
| Stremio has a `tt` id pulse doesn't know | `import` — add to watchlist |
| Pulse row wanted/in-flight, not yet pushed | `push` |
| Pulse row `on_server`, still present in Stremio | `remove` + stamp `stremio_dropped_at` |
| Stremio item `removed:true`, `stremio_dropped_at` NULL | viewer removed it → `delete` pulse row |
| Stremio item `removed:true`, `stremio_dropped_at` SET | pulse removed it → **ignore** |
| Stremio item present (`removed:false`), `stremio_dropped_at` SET | viewer re-added it → **clear `stremio_dropped_at`** |

That last row closes a hole: without it, once pulse has dropped an item, `stremio_dropped_at` stays
set forever, and every subsequent hand-removal of that title is misread as pulse's own and silently
ignored. Observing the item present again is what re-arms removal detection.

"Wanted" = watchlist row with `on_server = 0`. "In flight" = a matching `consumer_requests` row not
yet available. Both push; only `on_server` removes. `pulseRows` is therefore the **union** of the
two tables, deduplicated on `(tmdb_id, media_type)`.

**Type mapping is explicit**, since the two systems disagree: pulse `media_type` `movie` ↔ Stremio
`type` `movie`; pulse `tv` ↔ Stremio `series`. Any other Stremio `type` (e.g. `channel`, `tv`) is
**skipped on import** rather than guessed at.

## Sync engine

Runs inside the existing poller. `pollStremioSync(db)` is called from `tickPoll` alongside
`pollWatchlistAvailability`, inheriting the non-overlap guard and the `PULSE_DISABLE_POLLER`
kill switch.

**Ordering is a requirement:** availability runs *before* Stremio sync in the same tick, so a title
that just landed is dropped from Stremio in the same cycle rather than a cycle late.

**Two triggers:**

- **Push is event-driven.** `watchlistAdd` / `watchlistRemove` **and request creation
  (`/api/app/request`)** push immediately, so a title asked for on pulse appears on the TV in
  seconds, not up to two minutes later. All three call the same push path; none of them is allowed
  to fail the originating user action (best-effort, errors logged to `last_error`).
- **Pull is periodic and slower** than `POLL_MS` — `PULSE_STREMIO_SYNC_MS`, default `600000` (10 minutes).
  `datastoreGet` returns the entire library per call; polling that every 120s per linked consumer
  is waste against an API with no published rate limits.

Per-consumer isolation: one viewer's expired `authKey` must never stall another's sync.

## Linking

Gated on the **existing `watchlist` capability** — no new entry in the `Capability` union. Stremio
sync is a watchlist feature; widening the union and the roles UI buys a distinction nobody needs yet.

Flow, in `routes/app/account/+page.svelte`, mirroring the existing Plex link section:

1. Viewer enters Stremio email + password.
2. Pulse calls Stremio login, stores **only** the returned `authKey`, encrypted.
3. The password is discarded immediately — never persisted, never logged.

Fallback if no usable login endpoint exists: paste an `authKey`. Worse UX; another reason to resolve
the unverified item above first.

Endpoint `POST`/`DELETE /api/app/stremio`, consumer-session-gated. Deliberately **not** added to
`CONSUMER_PUBLIC` in `hooks.server.ts` — no unauthenticated path touches a credential. Rate-limited
via `request-limit.ts`; link and unlink both write `access_events` through `logAccess`.

The section surfaces connection status, last sync, last error, and a **Sync now** button — a
10-minute pull cadence needs an escape hatch when the viewer is standing at the TV.

Copy lives in both `en.json` and `pt-BR.json`. pt-BR strings stay direct and plain.

## Failure modes

| Failure | Behavior |
|---|---|
| `datastoreGet` response fails `zod` validation | **Abort the write.** Fail closed — never write on data that could not be parsed. |
| Expired / rejected `authKey` | `fail_count` increments; after **5** consecutive failures `enabled=0` and the app shows "reconnect your Stremio account". A successful sync resets the count to 0. No silent hammering. |
| No resolvable `imdb_id` | Row never syncs. Not an error, no retry loop, no log spam. |
| Seerr unreachable | Skip the entire cycle. Seerr is the id-mapping dependency; without it pushes would be wrong rather than merely late. |
| Stremio API shape change | Caught by `zod` as a validation failure; degrades to "sync stopped", never "library corrupted". |

**Security note:** after this feature `pulse.sqlite` holds live Stremio session keys for every
linked consumer. It becomes materially more sensitive than it is today.

**Blast radius:** all traffic is outbound to `api.strem.io`. No new route is exposed on the public
host, so the `PULSE_PUBLIC_HOST` guard in `hooks.server.ts` is untouched. The only new
consumer-facing surface is the link/unlink endpoint.

## Testing

- **`reconcile()` — exhaustive unit tests over the full truth table**, no network, no DB.
  Explicitly: a pulse-initiated drop is never read back as a viewer removal, and the
  drop → re-add → drop sequence terminates.
- `integrations/stremio.ts` against mocked `fetch`, matching how `seerr.test.ts` and the other
  integration tests are written.
- An explicit test that a push **preserves** an existing item's `state` object (Decision 3).
- Migration test in `db.test.ts`.
- Playwright smoke for the link UI in `e2e/`.
- **No test hits a live Stremio account in CI.** One supervised manual smoke against the owner's
  own account before enabling, with the feature defaulting to off.

## Staging

1. **Stage A — push only.** Wanted + in-flight appear in the Stremio Library; available titles are
   dropped. No pull, no import. Independently useful, and it proves the unofficial API against a
   real account for ~100 lines instead of a sync engine.
2. **Stage B — pull.** Adds `datastoreGet` diffing, import of viewer-added titles, and propagation
   of hand-removals per the reconciler contract.

The reconciler is written whole in Stage A (it is pure and cheap to test); Stage A simply ignores
its `import` and `delete` outputs.

## Out of scope

- Any Stremio **addon** (catalog/meta/stream). Browsing the Plex library inside Stremio and a
  "request via pulse" action there are a separate sub-project.
- Letterboxd / Trakt scrobbling of watch history.
- Capturing titles from YouTube trailers.

These are the other two edges of the same pipeline and get their own specs.
