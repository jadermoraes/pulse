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
| A participant removes a title in pulse | It leaves the shared list once **no** participant still wants it — but see the correction below: it does **not** leave the TV |
| A title lands on the media server | It leaves the Library (unchanged "drop when available") |

The fan-out that matters is the **inbound** one. A removal on the TV must reach every
participant's watchlist; without it the participants who still hold the row keep pushing the title
back and it reappears on the TV — the ping-pong the reconciler's guard exists to prevent,
re-introduced at a higher level. Fanning out inbound removals is what earns the word "shared".

The outbound direction needs no fan-out, and must not have one. The shared list is a union, so a
participant removing a title in pulse simply stops contributing it; the title leaves the TV when
the last contributor drops it. Deleting the other participants' rows on one person's say-so would
destroy data pulse was never asked to touch, and the union already makes the outbound direction
stable on its own: a title one person still wants is still wanted.

## Correction (2026-08-30): outbound removal never worked

The table above claims a pulse-side removal reaches the TV. It does not, and did not in the
per-viewer design either. `reconcile` decides imports with
`stremioItems.filter((s) => !s.removed && !knownImdb.has(s.imdbId))`, so a title removed from every
participant's watchlist is, by the next poll, present in Stremio and unknown to pulse — which is
exactly the import condition. It is re-imported within one cycle. No code path pushes
`removed: true` because a participant dropped a title in pulse.

Neither task review nor the whole-branch review caught it, because every test drives removal from
the Stremio side, which does work.

The union reasoning in this document is unaffected and stands: it governs when a title leaves the
shared *list*, and that part is correct. What was wrong was the claim that leaving the list
propagates outward to Stremio.

Fixed by `2026-08-30-watchlist-screen-and-household-removal.md`, which adds a transient
`household_removals` queue: the removal is pushed as `removed: true`, and the queued ids are
excluded from the list handed to the reconciler until that write lands.

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
4. **`sync_state` scope.** Provenance is now per household, not per consumer — so it moves to a
   **new `household_sync_state` table**, keyed `(spoke, entity, tmdb_id, media_type)` with no
   `consumer_id` column at all.

   Two alternatives were considered first and both are unusable. A reserved `consumer_id = 0`
   violates `sync_state`'s `REFERENCES consumer_users(id)`, and `foreign_keys` is `ON`, so the
   insert throws. Adding a nullable column needs an `ALTER`, and `migrate()` is `CREATE TABLE IF
   NOT EXISTS` only — the new column would appear on fresh databases and never on the live one.
   A brand-new table is the one shape that works on both, with no migration and no `ALTER`.
5. **Consumer UI.** The Stremio panel leaves the account page; Trakt's stays. The `stremio.*`
   strings move to the admin surface.
6. **Admin UI.** A bespoke Stremio panel in the Connections tab, backed by an admin
   `/api/stremio` endpoint — the same shape the roles, users and AI-connection panels on that page
   already use. `ConfigField` is left untouched.

   Registering a `stremio` Integration instead was the first plan and does not work. The generic
   connection form is built around `baseUrl` + `secret`: `?/create` rejects a blank `baseUrl`, and
   the `secret` it stores is whatever was typed into the password box — which for Stremio is the
   **password**, breaking this design's own "the password is never stored" rule. There is no hook
   in the `Integration` contract to exchange it for an authKey. Bending the shared form around one
   integration risks the nine that already depend on it, for no user-visible difference: the panel
   lands in the same tab either way.

   The connection row still carries a real `baseUrl` (`https://api.strem.io`) rather than an empty
   string, because `config.ts`'s import validator rejects a connection whose `baseUrl` is empty —
   an exported config would fail to re-import.

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
