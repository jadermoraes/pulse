# Sync Hub — Design

**Date:** 2026-08-28
**Status:** Approved design, not yet planned or implemented
**Supersedes the architecture of:** `2026-08-28-stremio-library-sync-design.md` (that doc's
reconciler contract, origin guard and ping-pong fix survive intact as hub logic; its Decision 3
is narrowed here).

## Goal

Pulse becomes the single source of truth for what a viewer wants to watch, has watched, is
watching, and how they rated it — and mirrors that to external services.

Two spokes at launch: **Trakt** and **Stremio**.

## Topology: star, never mesh

`pulse` is the hub. Spokes sync **only** to pulse, never to each other.

```
        Stremio  ◀──▶  [ PULSE ]  ◀──▶  Trakt
                          ▲
                          │
                    Tautulli/Plex (read-only source of plays)
```

With N spokes, a mesh needs N² sets of conflict rules; a star needs N. Adding a fourth service
later is one adapter, not a rewrite. This is the single most important decision in this document.

## What each spoke can actually do

Capability is a property of the external service, not a scope choice:

| Surface | Trakt | Stremio |
|---|---|---|
| Watchlist | full, two-way | full, two-way (library items) |
| Playback progress | scrobble API | `state.time_offset` on a library item |
| Watched history (dated play log) | full | **unsupported** — no history log exists |
| Ratings | full, two-way | **unsupported** — no rating field exists |

Each adapter therefore declares its capabilities, and the hub only asks for what a spoke supports:

```ts
interface SyncSpoke {
  readonly id: 'trakt' | 'stremio';
  readonly caps: {
    watchlist: boolean;
    progress: boolean;
    history: boolean;
    ratings: boolean;
  };
  // only the methods its caps advertise are ever called
}
```

Unsupported surfaces are skipped silently — never an error, never a retry.

## Hub data model

Existing, reused as-is: `consumer_watchlist` (+ the sync columns from the Stremio spec:
`imdb_id`, `stremio_synced_at`, `stremio_dropped_at` — generalized here to a per-spoke table,
see below).

**Generalization.** Rather than per-spoke columns on `consumer_watchlist`, sync state moves to:

```sql
CREATE TABLE IF NOT EXISTS sync_state (
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  spoke        TEXT NOT NULL,              -- 'trakt' | 'stremio'
  entity       TEXT NOT NULL,              -- 'watchlist' | 'progress' | 'history' | 'rating'
  tmdb_id      INTEGER NOT NULL,
  media_type   TEXT NOT NULL,
  synced_at    INTEGER,
  dropped_at   INTEGER,                    -- set ONLY when pulse itself removed it
  PRIMARY KEY (consumer_id, spoke, entity, tmdb_id, media_type)
);
```

This is what makes the origin guard work per-spoke instead of once for Stremio.

**New hub tables:**

```sql
CREATE TABLE IF NOT EXISTS watch_plays (          -- the play log; source of truth for history
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  tmdb_id      INTEGER,
  imdb_id      TEXT,
  media_type   TEXT NOT NULL,               -- 'movie' | 'tv'
  season       INTEGER,                     -- TV only
  episode      INTEGER,                     -- TV only
  watched_at   INTEGER NOT NULL,            -- ms epoch
  source       TEXT NOT NULL,               -- 'tautulli'
  source_row   INTEGER,                     -- tautulli row_id, for dedupe
  UNIQUE(consumer_id, source, source_row)
);

CREATE TABLE IF NOT EXISTS consumer_ratings (
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  tmdb_id      INTEGER NOT NULL,
  media_type   TEXT NOT NULL,
  rating       INTEGER NOT NULL,            -- 1..10 (Trakt scale)
  rated_at     INTEGER NOT NULL,            -- ms epoch; the last-write-wins key
  PRIMARY KEY (consumer_id, tmdb_id, media_type)
);

CREATE TABLE IF NOT EXISTS spoke_credentials (
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  spoke        TEXT NOT NULL,
  secret       TEXT NOT NULL,               -- encrypted via crypto.ts
  refresh      TEXT,                        -- encrypted; Trakt OAuth refresh token
  expires_at   INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_error   TEXT,
  PRIMARY KEY (consumer_id, spoke)
);
```

`spoke_credentials` replaces the `consumer_stremio` table proposed in the Stremio spec.

## Ingest: Tautulli → `watch_plays`

Plays enter the hub from one place only.

- `get_history` with `start`/`length`, walked from the highest `source_row` already stored.
  **`row_id` is the cursor and the dedupe key** — the `UNIQUE(consumer_id, source, source_row)`
  constraint makes double-ingest impossible rather than unlikely.
- **A play counts as watched when `watched_status == 1`.** Partial plays are not ingested.
- `media_index` / `parent_media_index` give episode / season.
- **External ids come from `get_metadata(rating_key)`**, which returns `guids`
  (`imdb://tt…`, `tmdb://…`). Plex's `guid` on the history row is agent-dependent and not
  reliable. Results are cached permanently keyed by `rating_key` — a rating_key's ids never change.
- **Per-user filtering is a correctness requirement.** Tautulli history covers everyone on the
  server. Rows are matched to a consumer via `consumer_users.plex_account_id`; a row that matches
  no linked consumer is ignored. Getting this wrong publishes someone else's viewing to a
  viewer's public Trakt profile.

Jellyfin/Jellystat as a second source is out of scope for now; the `source` column exists so it
can be added without migration.

## Spoke: Trakt

OAuth2 (authorization code + refresh). Per-consumer tokens in `spoke_credentials`.

**Watched history — gap-filler only.** Trakt's scrobble endpoint already writes to history when a
play completes, so pushing every `watch_plays` row would duplicate. History sync therefore pushes
only plays Trakt does not already have (compare against `/sync/history` for the title), and exists
to cover plays that happened while pulse was down or before the account was linked.

**Progress — live scrobble.** Driven off `aggregateNowPlaying()`, which already polls Plex/Jellyfin
sessions. `start` / `pause` / `stop` per Trakt's scrobble API.

**Watchlist — two-way**, using the reconciler and origin guard from the Stremio spec, now keyed
through `sync_state`.

**Ratings — two-way, last-write-wins on `rated_at`.** Both sides expose a timestamp, so the
comparison is real. Equal timestamps: pulse wins (deterministic, avoids flapping).

## Spoke: Stremio

Unofficial `api.strem.io` datastore (`datastoreGet` / `datastorePut`, collection `libraryItem`,
items keyed by **IMDb `tt` ids**). Full details of the API, the linking flow, and the watchlist
reconciler contract remain in `2026-08-28-stremio-library-sync-design.md`.

`caps = { watchlist: true, progress: true, history: false, ratings: false }`.

**Revision to that spec's Decision 3.** It said pushes must never touch `state`, to protect watch
progress. Now that pulse syncs progress, pulse *is* a writer of that field. The rule narrows:

> **Progress is monotonic. Pulse writes `state.time_offset` only when its value is greater than
> what Stremio currently holds.**

Playback position only advances within a viewing, so "take the max" is always correct. No
timestamps, no locking, no lost-update window — and pulse still can never erase progress, which
was the original point. All other fields of `state` remain read-modify-write preserved.

## Scheduling

All of it runs inside the existing `startEventPoller` (`agent/events.ts:273`), inheriting the
non-overlap guard and `PULSE_DISABLE_POLLER=1`.

| Job | Cadence | Why |
|---|---|---|
| Scrobble (live progress) | `POLL_MS` (120s) | Must be responsive; already polling sessions anyway |
| Tautulli ingest | `POLL_MS` | Cheap — cursor-limited, usually zero new rows |
| Watchlist / ratings pull | ~10 min (`PULSE_SYNC_PULL_MS`, default `600000`) | Full-collection reads; wasteful at 120s |
| Push (watchlist, ratings) | event-driven, immediate | A change made in pulse should appear on the TV in seconds |

Ordering within a tick: **ingest → availability → spoke sync**, so a title that just became
available is dropped from the spokes in the same cycle rather than a cycle late.

Per-consumer and per-spoke isolation: one expired token must never stall anyone else's sync.

## Failure modes

| Failure | Behavior |
|---|---|
| Spoke response fails `zod` validation | **Abort the write.** Fail closed — never write on unparseable data. |
| Expired / rejected credential | Trakt: refresh once. On failure (either spoke) `fail_count`++; at 5 consecutive, `enabled=0` and the app prompts to reconnect. Success resets to 0. |
| No resolvable external id | Row never syncs. Not an error, no retry loop, no log spam. |
| Tautulli unreachable | Skip ingest this cycle. Cursor is unchanged, so nothing is lost. |
| Spoke lacks a capability | Skipped silently, by design. |
| Stremio API shape change | Caught by `zod`; degrades to "sync stopped", never "library corrupted". |

**Security:** `pulse.sqlite` will hold live Trakt OAuth tokens and Stremio session keys for every
linked consumer. It becomes materially more sensitive than it is today. All secrets encrypted at
rest via `crypto.ts`; passwords never persisted.

**Blast radius:** all traffic is outbound. The only new consumer-facing routes are link/unlink,
which are consumer-session-gated and deliberately **not** added to `CONSUMER_PUBLIC` in
`hooks.server.ts`.

## Staging

1. **Tautulli ingest → `watch_plays`.** No spoke writes at all. Verifiable on its own, and every
   later stage depends on it.
2. **Trakt: history gap-filler.** First outbound writes. Proves OAuth and id resolution.
3. **Trakt: live scrobble.** Adds the second write path; the gap-filler's dedupe rule is what
   makes it safe.
4. **Stremio: watchlist.** The originally specified feature, now as a spoke.
5. **Trakt: watchlist.** Second watchlist spoke — proves the adapter abstraction is real.
6. **Stremio: progress**, under the monotonic rule.
7. **Trakt: ratings**, two-way with LWW.

Stages 1–3 are Plex→Trakt and independently useful. Stage 5 is the one that validates the
architecture: if adding the second watchlist spoke isn't nearly free, the abstraction is wrong.

## Testing

- **The reconciler stays a pure function** — exhaustive unit tests over the truth table, including
  that a pulse-initiated removal is never read back as a user removal, and that
  drop → re-add → drop terminates.
- **Monotonic progress:** a test that a lower incoming offset never overwrites a higher stored one.
- **Dedupe:** ingesting the same Tautulli `row_id` twice inserts one row; a play already in Trakt
  history is not re-pushed.
- **Per-user isolation:** a play by a non-linked Plex user reaches no spoke. This one matters most —
  its failure mode is publishing someone else's viewing.
- Spoke clients tested against mocked `fetch`, matching `seerr.test.ts` and the other integrations.
- Migration tests in `db.test.ts`.
- **No test hits a live Trakt or Stremio account in CI.** One supervised manual smoke per spoke,
  against the owner's own accounts, feature off by default.

## Out of scope

- Jellyfin/Jellystat as a play source (the `source` column leaves room).
- Letterboxd as a spoke — API is access-by-request only. Trakt history exports to Letterboxd's CSV
  importer in the meantime. If access is granted later it becomes a third adapter.
- Capturing titles from YouTube trailers — separate spec, feeds `consumer_watchlist`, and reaches
  every spoke for free once this exists.
- Any Stremio addon (catalog / meta / stream). Browsing the Plex library inside Stremio remains a
  separate sub-project.
