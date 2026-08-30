import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listWatchlist } from '$lib/server/consumer/watchlist';
import { removeWatchlistEverywhere } from '$lib/server/consumer/watchlist-remove';
import { getConsumer, effectiveAllowList } from '$lib/server/identity/consumers';
import { getRole } from '$lib/server/identity/roles';
import type { DB } from '$lib/server/db';

/**
 * Gate on the EXISTING `watchlist` capability. No other REST endpoint under /api/app checks a
 * capability today — gating has lived only in the agent tool layer — but the same operations are
 * already governed by this capability through chat, so leaving REST ungated would make the
 * capability a fiction.
 */
function requireWatchlist(db: DB, consumerId: number): void {
  const c = getConsumer(db, consumerId);
  if (!c) throw error(401, 'Unauthorized');
  const role = getRole(db, c.roleId);
  if (!role || !effectiveAllowList(c, role).includes('watchlist')) throw error(403, 'Forbidden');
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  requireWatchlist(db, locals.consumer.id);
  // Project consumerId away — it is an internal id and the viewer only ever sees their own rows.
  return json(listWatchlist(db, locals.consumer.id).map((r) => ({
    id: r.id, tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title,
    onServer: r.onServer, notifyOnAvailable: r.notifyOnAvailable, addedAt: r.addedAt
  })));
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  requireWatchlist(db, locals.consumer.id);

  let body: any;
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const tmdbId = Number(body?.tmdbId);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw error(400, 'tmdbId required');
  const mediaType = body?.mediaType === 'tv' ? 'tv' : 'movie';

  const r = await removeWatchlistEverywhere(db, { actorId: locals.consumer.id, tmdbId, mediaType });
  return json({ ok: r.removed, household: r.household });
};
