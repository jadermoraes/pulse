import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getConsumer } from '$lib/server/identity/consumers';
import { createConsumerRequest } from '$lib/server/consumer/requests';
import { logAccess } from '$lib/server/identity/access-log';

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: { tmdbId?: number; mediaType?: string };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const tmdbId = Number(body.tmdbId);
  const mediaType = body.mediaType === 'tv' ? 'tv' : 'movie';
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw error(400, 'tmdbId required');
  const consumer = getConsumer(db, locals.consumer.id);
  if (!consumer) throw error(401, 'Unauthorized');
  const created = await createConsumerRequest(db, consumer, { tmdbId, mediaType });
  logAccess(db, {
    consumerId: consumer.id, type: 'request', detail: created.title,
    ip: getClientAddress(), userAgent: request.headers.get('user-agent') ?? undefined
  });
  return json(created);
};
