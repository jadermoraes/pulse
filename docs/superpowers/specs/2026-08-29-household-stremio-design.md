# Household Stremio — Design

**Date:** 2026-08-29
**Status:** Approved in conversation; supersedes the per-consumer model of
`2026-08-28-stremio-library-sync-design.md` for the Stremio spoke only.

## Problem

The Stremio spoke shipped as a **per-viewer** integration: each consumer links their own Stremio
account from the account page, and pulse syncs that person's watchlist to that person's Library.

That is the wrong shape for this household. There is **one** Stremio account, on the family TV.
Worse, some pulse consumers are invites who have no access to it at all — under the per-viewer
model they would either link nothing (harmless) or, if an admin linked on their behalf, pulse would
be storing someone else's password for an account they don't own.

**Trakt stays per-viewer and is unaffected.** A Trakt profile genuinely is personal; a living-room
Stremio account is not.

## Model

**One household Stremio connection, configured by the admin in dash → Connections**, alongside
Jellyfin and Seerr. Plus an explicit list of which consumers take part.

- Credentials live in the existing `connections` table: `type='stremio'`, `secret` = the authKey
  (encrypted by the existing connection layer), `options` = `{ email, participantIds: number[] }`.
- The email is kept only to show which account is linked. **The password is never stored** — it is
  exchanged for an authKey once, exactly as the per-viewer flow already does.
- Non-participants are untouched: their watchlists stay private to pulse and never reach Stremio.

## Shared semantics

The household list is the **union of participants' watchlists and their not-yet-available
requests**. From Stremio's side that is one list, which is what a shared TV should show.

"Shared" applies in both directions, and this is what makes the model coherent rather than merely
convenient:

| Event | Effect |
|---|---|
| A participant adds a title in pulse | It appears in the household Library |
| A title is saved on the TV | It is added to **every** participant's watchlist |
| A title is removed on the TV | It is removed from **every** participant's watchlist |
| A participant removes a title in pulse | It leaves the shared list, so it leaves the TV |
| A title lands on the media server | It leaves the Library (unchanged "drop when available") |

Without the fan-out on removal, one participant deleting a title would leave the others still
pushing it, and it would reappear on the TV — the ping-pong the reconciler's guard exists to
prevent, re-introduced at a higher level. Fanning out removals is what earns the word "shared".

## What carries over unchanged

The parts that took the most review to get right are independent of *whose* list is being synced,
because they operate on two lists and nothing else:

- `integrations/stremio.ts` — the datastore client, fail-closed validation, the 401/403-vs-transient
  error split.
- `integrations/cinemeta.ts` — imdb↔tmdb resolution and the permanent cache.
- **`consumer/stremio-reconcile.ts` — the pure reconciler and its `dropped_at` provenance guard.**
  It takes `PulseItem[]` and `StremioItem[]`; it neither knows nor cares that the first list is now
  a union. **Do not modify it.**
- `sync_state` for provenance, and the poller ordering (ingest → availability → spoke sync).

## What changes

1. **Credential location.** From `spoke_credentials` keyed `(consumer_id, 'stremio')` to a single
   `connections` row. `spoke_credentials` remains for Trakt.
2. **Sync inputs.** `loadPulseItems` becomes household-scoped: the union of participants' watchlist
   rows and their `pending`/`processing`/`available` requests, deduplicated on
   `(tmdb_id, media_type)` — with the existing rule that a watchlist row wins over a request row,
   and that a title is `onServer` only when every contributing row says so.
3. **Write-back fans out.** Imports and hand-removals apply to every participant, inside one
   transaction so a partial fan-out cannot leave participants disagreeing.
4. **`sync_state` scope.** Provenance is now per household, not per consumer. Use a reserved
   `consumer_id` of `0` for the household row, or add a nullable column — whichever avoids a
   migration, since `migrate()` has no `ALTER` path.
5. **Consumer UI.** The Stremio panel leaves the account page; Trakt's stays. The `stremio.*`
   strings move to the admin surface.
6. **Admin UI.** A `stremio` integration registered in the existing registry. Its `configSchema`
   needs a field type the current `ConfigField` union lacks — a consumer multi-select for
   `participantIds`. That is a small, contained extension (`type: 'consumers'`), rendered by the
   settings page.

## Migration

**None required.** Verified against the live database on 2026-08-29: zero rows in
`spoke_credentials` with `spoke='stremio'`, and zero `sync_state` rows for that spoke — nobody ever
linked, because the UI shipped only hours earlier. The per-consumer code path can be removed
outright rather than migrated.

## Failure modes

Unchanged in kind from the per-viewer design, with one addition: **a participant list that includes
a consumer who is later deleted.** `participantIds` lives in a JSON blob with no foreign key, so a
stale id must be skipped silently rather than throwing — resolve participants by joining against
`consumer_users` and ignore ids that no longer resolve.

Everything else carries over: fail closed on unparseable responses, 401/403 disables the connection
while transient errors only note, per-cycle isolation so a Stremio outage cannot break the poller,
and the staged `sync_state` writes that are drained only after `datastorePut` succeeds.

## Out of scope

- Trakt (stays per-viewer).
- Playback-progress sync (still a follow-up).
- A Stremio **addon** — catalogs, metadata and streaming from Jellyfin into Stremio. That is a
  separate, inbound-facing subsystem and gets its own design. This document is only about the
  Library sync.
