# Stremio Addon — Design

**Date:** 2026-08-30
**Status:** Approved in conversation.
**Related:** `2026-08-29-household-stremio-design.md` (the OUTBOUND Library sync, shipped). This
document is the INBOUND direction and shares nothing with it but the word "Stremio".

## Problem

Pulse pushes a watchlist into the household Stremio Library, but the media itself lives in Jellyfin
and is invisible from inside Stremio. Watching something you already own means leaving Stremio for
the Jellyfin web UI. And a title you *don't* own can only be requested from the pulse app.

Two things are wanted, from inside Stremio on the TV and on the PC:

1. **Browse and play the Jellyfin library.**
2. **Request a missing title.**

## What Stremio actually allows

An addon is a read-only HTTP server. It answers four resource types and can do nothing else — there
is no button, no form, no way to POST. Everything below is shaped by that.

- `catalog` — rows of items. This is the browse surface.
- `meta` — the detail page for an item.
- `stream` — the list of playable sources for an item. **This is the only lever an addon has**, and
  the request feature is built on it: an entry whose selection is itself the action.
- `subtitles` — not used.

## Decisions taken

### The addon declares `catalog` and `stream` only — not `meta`

Every item is keyed by its **IMDb id**, and Cinemeta (installed by default in every Stremio) already
serves rich metadata for `tt` ids. Declaring `idPrefixes: ['tt']` and omitting `meta` means Stremio
renders detail pages from Cinemeta and asks us only for streams.

This deletes the single largest piece of work — no meta endpoint, and no season/episode *metadata*
tree, which pulse models nowhere today (TV is a whole-show, tmdb-keyed unit throughout). Episodes
still have to be resolved for **playback**, but not for display.

**The cost, stated plainly: a Jellyfin item with no IMDb provider id cannot be surfaced at all.**
Radarr/Sonarr-managed libraries almost always carry one; hand-added items may not. A short catalog
is better than inventing ids Cinemeta cannot resolve.

**This is an assumption, not a documented guarantee.** The SDK docs do not state that Stremio falls
back to another addon for meta when one is not declared. If a catalog item's detail page comes up
empty, the fix is contained: add a `meta` resource backed by the existing `jellyfin.detail(conn, {id})`.

### Video is proxied through pulse, not linked directly

Jellyfin authenticates by `?api_key=`, so a direct stream URL would embed an effectively
admin-level key in a URL handed to every device with the addon installed. Pulse proxies instead:
the key stays server-side.

The proxy **must forward `Range` and return `206` with `Content-Range`**, or seeking breaks. The
existing poster proxy at `/api/image/[connectionId]` is the shape to copy, but it does not handle
`Range` and that is the one thing this route cannot omit.

### One household token, in the URL path

An addon URL cannot carry a cookie. A single token identifies the household, and requests made
through it are attributed to one nominated pulse consumer. This matches how the household Stremio
account already works, and the request path needs a real consumer anyway — `createConsumerRequest`
posts to Seerr as `consumer.seerrUserId`.

### Requesting is a stream entry that acts when selected

A title not on the server gets exactly one entry, "Request on pulse". Selecting it makes Stremio
fetch that URL; pulse creates the request and returns a short static clip confirming it. Selection
is a deliberate act — Stremio fetches a stream URL when the viewer picks it, not while browsing.

**Repeated selection must not stack requests.** If a `pending`, `processing` or `available` request
already exists for that title, the endpoint plays the clip and does nothing else.

## Routes

All under `/api/_public`, which `hooks.server.ts` already exempts from every auth gate and which
nothing currently uses. Two consequences, both wanted: the handler owns 100% of its own auth, and
the whole family 404s on `PULSE_PUBLIC_HOST`, so the addon is LAN-only by default.

```
/api/_public/addon/<token>/manifest.json
/api/_public/addon/<token>/catalog/<type>/<catalogId>.json
/api/_public/addon/<token>/catalog/<type>/<catalogId>/<extras>.json
/api/_public/addon/<token>/stream/<type>/<id>.json
/api/_public/addon/<token>/play/<jellyfinItemId>
/api/_public/addon/<token>/request/<type>/<id>
```

`<extras>` is a query string stringified into the path segment, e.g. `search=blade%20runner&skip=100`.

**Stream and play URLs are built from the incoming request's own origin**, so whatever address the
addon was installed at is the address the TV streams from. No new environment variable, and no
guessing at pulse's LAN address.

## Data

One new table. `migrate()` has no `ALTER` path and is uncaught in `getDb()`, so a new table is the
only safe move:

```sql
CREATE TABLE IF NOT EXISTS addon_tokens (
  token        TEXT PRIMARY KEY,
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
```

`ON DELETE CASCADE` means deleting the attributed consumer revokes the addon, which is the correct
failure direction. `last_used_at` is what tells an admin whether the TV is actually using it.

Token minting follows the established pattern (`identity/invites.ts`, `identity/password-reset.ts`):
`randomBytes(24).toString('hex')`.

## Resolution chain

- **Catalog:** `GET /Items?Recursive=true&IncludeItemTypes=Movie|Series&Fields=ProviderIds,ProductionYear&SortBy=…&StartIndex=<skip>&Limit=<n>`, filtered to items carrying an IMDb provider id, mapped to `{ id, type, name, poster, releaseInfo }`.
- **Movie stream:** `tt…` → `GET /Items?Recursive=true&IncludeItemTypes=Movie&AnyProviderIdEquals=imdb.tt…&Limit=1` → item id. One call; the two-hop `resolveImdbMeta` → `resolveJellyfinItemId` chain pulse implies today is unnecessary.
- **Episode stream:** `tt…:S:E` → the same lookup with `IncludeItemTypes=Series` → then the series' episodes, matching `ParentIndexNumber === S && IndexNumber === E`. Nothing in pulse does this today.
- **Availability for the request branch:** a title is "not on the server" when the imdb lookup returns nothing. This deliberately asks **Jellyfin**, not Seerr — the question here is "can I play it right now", which is exactly what Jellyfin answers. (Contrast `discover.ts`, which asks Seerr for *availability* because Jellyfin's recently-added list contains Radarr/Sonarr placeholders for undownloaded titles. That reasoning does not apply to a direct id lookup.)

## Vocabulary

Three vocabularies meet here and must not be confused:

| Layer | Movie | TV |
|---|---|---|
| Stremio / Cinemeta | `movie` | `series` |
| pulse / Seerr | `movie` | `tv` |
| `imdb_meta_cache.media_type` | `movie` | `series` |

`stremioType()` in `consumer/stremio-reconcile.ts` is the existing translator. The addon speaks
Stremio's vocabulary on the wire and pulse's internally.

## Admin surface

A panel in dash: mint a token, choose the consumer requests are attributed to, show the install URL
for copying, show `last_used_at`, and revoke. Same shape as the household Stremio panel.

## Failure handling

- An unknown, revoked, or malformed token returns **404**, not 401 — the addon should be invisible
  rather than advertising that a valid token exists. IP backoff via the existing `ratelimit.ts`
  helpers, as `/api/app/reset` does.
- Jellyfin unreachable → an empty catalog and no streams, never a 500. Stremio degrades to showing
  nothing rather than an error.
- An id Jellyfin cannot resolve → an empty stream list, not an error.
- A request that Seerr rejects → the clip still plays, and the failure is logged. The viewer has no
  channel to read an error in, so failing loudly would only produce a broken-video symbol.

## Security

The token is a bearer credential in a URL. It grants: read of the entire library catalogue,
streaming of any item, and requesting as one consumer. It is LAN-only by default, revocable, and
its use is timestamped. It does **not** grant access to any other pulse surface.

Every handler validates the token before touching Jellyfin. The `play` route must reject an item id
that is not a plain Jellyfin GUID, and must never accept a caller-supplied URL or path — the SSRF
guard the poster proxy already demonstrates.

## Out of scope

- `meta` (see the assumption above).
- Subtitles.
- Per-consumer addon tokens; one household token only.
- Per-season requests — `createConsumerRequest` sends `seasons: 'all'`, unchanged.
- Transcoding. The proxy passes bytes through; if a client cannot play a container, that is between
  the client and the file.
- Surfacing Jellyfin items that carry no IMDb id.
