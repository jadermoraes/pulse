/**
 * The Stremio addon dispatcher.
 *
 * This route family is PUBLIC: hooks.server.ts exempts `/api/_public/**` from every auth gate, so
 * this handler owns 100% of its own security. The bearer of the URL is the credential.
 *
 * One catch-all rather than a route per resource: the protocol puts a `.json` suffix and an
 * embedded query string into path segments, which SvelteKit's matcher handles badly. The handler
 * stays thin and delegates to $lib/server/addon/*.
 *
 * The Jellyfin api key lives only in the URLs this handler fetches upstream: it must never appear
 * in a response body, a response header, a redirect Location or a log line.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConnections, type Connection } from '$lib/server/connections';
import { resolveAddonToken, touchAddonToken } from '$lib/server/addon/tokens';
import { buildManifest, parseExtras, toMetaPreviews, CATALOG_IDS } from '$lib/server/addon/catalog';
import { parseStreamId, buildPlayStream, buildRequestStream } from '$lib/server/addon/stream';
import {
  listLibrary, findByImdb, findEpisode, upstreamStreamUrl, upstreamPosterUrl
} from '$lib/server/addon/jellyfin-library';
import { resolveImdbMeta } from '$lib/server/integrations/cinemeta';
import { getConsumer } from '$lib/server/identity/consumers';
import { createConsumerRequest } from '$lib/server/consumer/requests';
import { logAccess } from '$lib/server/identity/access-log';
import { rateLimit } from '$lib/server/request-limit';
import { loginAllowed, recordLoginFailure, recordLoginSuccess } from '$lib/server/ratelimit';

const PAGE = 100;

/**
 * SSRF guard for the two proxy branches. Both interpolate a caller-supplied id into an upstream
 * URL, so accept only what a Jellyfin id can actually look like — nothing with a scheme, a path
 * traversal, a `?` that could rewrite the api_key parameter, or whitespace.
 */
const JF_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Image tags are hex digests; the poster tag is concatenated into a query string unencoded. */
const JF_TAG_RE = /^[A-Za-z0-9]{1,64}$/;

/** Everything unknown, unauthorised or unsupported answers the same way: 404, no body. */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

/** Stremio caches aggressively; a short TTL keeps a freshly-added title from being invisible. */
function jsonRes(body: unknown): Response {
  return json(body, { headers: { 'Cache-Control': 'public, max-age=60' } });
}

function jellyfinConn(db: ReturnType<typeof getDb>): Connection | null {
  return listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled) ?? null;
}

function stremioType(t: string): 'movie' | 'series' | null {
  return t === 'movie' ? 'movie' : t === 'series' ? 'series' : null;
}

/** Strip the protocol's `.json` suffix from a path segment. */
function bare(segment: string): string {
  return segment.replace(/\.json$/, '');
}

/**
 * The segment is caller-supplied, so a lone `%` or a broken escape is reachable from the open
 * internet-facing path. decodeURIComponent throws on those, which would be a 500 on a route whose
 * whole contract is "never 500". Undecodable input is simply not a valid id.
 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export const GET: RequestHandler = async ({ params, url, request, getClientAddress }) => {
  const db = getDb();

  // Resolve the caller's address ONCE, up front. adapter-node throws from getClientAddress() when
  // ADDRESS_HEADER is set and the header is absent, and on this route a throw is a 500 handed to
  // anyone who can guess the path. A null ip simply means no per-IP backoff for this request.
  let ip: string | null = null;
  try { ip = getClientAddress(); } catch { ip = null; }

  // Failure backoff (ratelimit.ts, the same helpers /api/app/reset uses) so this route is not a
  // free brute-force oracle for the one credential it has. Keyed under its own `addon:` namespace
  // so addon guessing and admin/consumer login backoff cannot clear or trip each other.
  // A locked-out caller gets the SAME bare 404 as every other rejection — the response must stay
  // indistinguishable from "no such token" and "no such resource".
  const ipKey = ip ? `addon:${ip}` : null;
  if (ipKey && !loginAllowed(ipKey).allowed) return notFound();

  const token = String(params.token ?? '');
  const auth = resolveAddonToken(db, token);
  // 404 not 401: a 401 would confirm that valid tokens exist for this path.
  if (!auth) {
    if (ipKey) recordLoginFailure(ipKey);
    return notFound();
  }
  if (ipKey) recordLoginSuccess(ipKey); // a live token clears the guesser's counter for this ip
  touchAddonToken(db, token);

  const parts = String(params.resource ?? '').split('/').filter(Boolean);
  if (parts.length === 0) return notFound();
  const origin = url.origin;

  if (parts.length === 1 && parts[0] === 'manifest.json') {
    return jsonRes(buildManifest());
  }

  const conn = jellyfinConn(db);

  // catalog/<type>/<id>.json  |  catalog/<type>/<id>/<extras>.json
  if (parts[0] === 'catalog' && (parts.length === 3 || parts.length === 4)) {
    const type = stremioType(parts[1]);
    if (!type) return notFound();
    const catalogId = parts.length === 3 ? bare(parts[2]) : parts[2];
    if (catalogId !== CATALOG_IDS[type]) return notFound();
    // Jellyfin unreachable or unconfigured degrades to an empty row, never an error: Stremio
    // shows an addon error as a broken row with no explanation.
    if (!conn) return jsonRes({ metas: [] });
    const rawExtras = parts.length === 4 ? safeDecode(bare(parts[3])) ?? undefined : undefined;
    const extras = parseExtras(rawExtras);
    const items = await listLibrary(conn, { type, skip: extras.skip, limit: PAGE, search: extras.search });
    return jsonRes({ metas: toMetaPreviews(items, origin, token) });
  }

  // stream/<type>/<id>.json
  if (parts[0] === 'stream' && parts.length === 3) {
    const type = stremioType(parts[1]);
    if (!type) return notFound();
    const rawId = bare(parts[2]);
    const decoded = safeDecode(rawId);
    const parsed = decoded === null ? null : parseStreamId(decoded);
    if (!parsed) return jsonRes({ streams: [] });
    if (!conn) return jsonRes({ streams: [] });

    const found = await findByImdb(conn, parsed.imdbId, type);
    if (!found) {
      // Not in the library at all — offer the request action instead of nothing.
      return jsonRes({ streams: [buildRequestStream(origin, token, type, rawId)] });
    }

    let playId: string | null = found.jellyfinId;
    if (parsed.season !== null && parsed.episode !== null) {
      // A series' own item id is not playable — resolve the episode.
      playId = await findEpisode(conn, found.jellyfinId, parsed.season, parsed.episode);
    }
    if (!playId) return jsonRes({ streams: [] });
    return jsonRes({ streams: [buildPlayStream(origin, token, playId, found.name)] });
  }

  // play/<jellyfinItemId>
  if (parts[0] === 'play' && parts.length === 2) {
    if (!conn) return notFound();
    const itemId = parts[1];
    // SSRF guard: the id is caller-supplied and is interpolated into an upstream URL.
    if (!JF_ID_RE.test(itemId)) return notFound();

    // `upstreamStreamUrl` returns null when the connection's baseUrl cannot be parsed (a value
    // saved without a scheme, e.g. `192.168.1.5:8096`). Treat it exactly like an unreachable
    // Jellyfin — a 404, never a throw, and never a fetch of the literal string "null".
    const target = upstreamStreamUrl(conn, itemId);
    if (!target) return notFound();

    const range = request.headers.get('range');
    let upstream: Response;
    try {
      upstream = await fetch(target, { headers: range ? { Range: range } : {} });
    } catch {
      return notFound();
    }
    // 416 is a legitimate answer to a Range request, not a missing file — forward it (with its
    // Content-Range, which tells the player the real length) rather than flattening it to 404. A
    // player probing past the end of a file must not be told the media does not exist.
    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) return notFound();

    // Forward exactly the headers that make seeking work — an allow-list, so nothing upstream can
    // leak the api key or the internal host back to the client. Content-Range and Accept-Ranges
    // are the load-bearing pair: without them a player cannot seek, and some refuse to start.
    const headers = new Headers();
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    // Do NOT invent Accept-Ranges. Upstream answering 200 to a Range request means it will not
    // seek; telling the player otherwise makes it retry a seek that cannot work.
    if (!headers.has('Accept-Ranges') && upstream.status === 206) headers.set('Accept-Ranges', 'bytes');
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // poster/<jellyfinItemId>/<tag>
  if (parts[0] === 'poster' && parts.length === 3) {
    if (!conn) return notFound();
    const [, itemId, tag] = parts;
    if (!JF_ID_RE.test(itemId) || !JF_TAG_RE.test(tag)) return notFound();
    // Built through `jf()` rather than by string concatenation, so an unparseable baseUrl yields
    // null here instead of a fetch of a string that carries the api key.
    const target = upstreamPosterUrl(conn, itemId, tag);
    if (!target) return notFound();
    let upstream: Response;
    try { upstream = await fetch(target); } catch { return notFound(); }
    // Without this, Jellyfin's 401 HTML body is served as Content-Type: image/* and cached for a
    // day — an error page pretending to be a poster.
    if (!upstream.ok) return notFound();
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'image/jpeg',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  }

  // request/<type>/<id>
  if (parts[0] === 'request' && parts.length === 3) {
    const type = stremioType(parts[1]);
    // Decode with the SAME safeDecode the stream branch uses, and validate the DECODED value.
    // The stream branch passes the still-encoded id into `buildRequestStream`, so what arrives
    // here can be percent-escaped — validating the raw form would reject every episode request.
    // `decodeURIComponent` also throws on a malformed escape like `%zz`, which on this
    // unauthenticated route would be a 500.
    const decoded = type ? safeDecode(parts[2]) : null;
    const parsed = decoded === null ? null : parseStreamId(decoded);
    if (!type || !parsed) return notFound();

    // Rate-limit ONLY this branch. `play`/`poster` must stay unthrottled: a single playback
    // session issues many Range requests and throttling them breaks seeking. `request` writes to
    // Seerr, so it is the one that needs a ceiling. Keyed on the token, 10 per 60s.
    // `rateLimit` RETURNS {ok, retryAfter} — it does not throw, so an unchecked call is a no-op.
    // On refusal still fall through to the 302: the viewer's only channel is the video that plays
    // next, and the idempotency guard below already makes repeats cheap.
    const burst = rateLimit(`addon-request:${token}`, 10, 60_000);

    const consumer = getConsumer(db, auth.consumerId);
    // A disabled consumer must not have requests filed as them. Their PWA session is rejected at
    // identity/consumer-auth.ts; the addon token outlives that (ON DELETE CASCADE covers deleting
    // a consumer, not disabling one), so it has to check too. Play and catalog stay available —
    // disabling someone should stop them SPENDING, not stop the TV.
    if (burst.ok && consumer && consumer.status !== 'disabled') {
      const mediaType = type === 'series' ? 'tv' : 'movie';
      try {
        const meta = await resolveImdbMeta(db, parsed.imdbId, type);
        if (meta?.tmdbId != null) {
          // Selecting a stream is cheap and repeatable — a viewer may well click twice. Only the
          // first click may become a request.
          const existing = db.prepare(
            `SELECT 1 FROM consumer_requests
              WHERE consumer_id=? AND tmdb_id=? AND media_type=?
                AND status IN ('pending','approved','processing','available')`
          ).get(consumer.id, meta.tmdbId, mediaType);
          if (!existing) {
            await createConsumerRequest(db, consumer, { tmdbId: meta.tmdbId, mediaType });
            logAccess(db, {
              consumerId: consumer.id, type: 'request', detail: `${meta.name} (stremio addon)`,
              ip: ip ?? undefined
            });
          }
        }
      } catch {
        // The viewer's only channel is the video that plays next; a thrown error would surface as
        // a broken-media icon with no explanation. Swallow and still play the confirmation.
      }
    }

    // Redirect to the static clip rather than reading it off disk. In production there is NO
    // `static/` directory: the Dockerfile copies only `build/`, and adapter-node serves static
    // assets from `build/client/`, so `readFile('static/…')` resolves against CWD `/app` and
    // throws — passing every local test and silently playing nothing on the server. adapter-node
    // already serves this file at `/addon/requested.mp4` with the right type and Range support.
    return new Response(null, {
      status: 302,
      headers: { Location: `${origin}/addon/requested.mp4` }
    });
  }

  return notFound();
};
