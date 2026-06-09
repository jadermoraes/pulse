import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getDetail } from '$lib/server/consumer/discover';
import { getConsumer } from '$lib/server/identity/consumers';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  const tmdbId = Number(url.searchParams.get('tmdbId'));
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw error(400, 'tmdbId required');
  const mediaType = url.searchParams.get('mediaType') === 'tv' ? 'tv' : 'movie';
  // Localize the synopsis/genres to the viewer's language (default 'en').
  const language = getConsumer(db, locals.consumer.id)?.language || 'en';
  const detail = await getDetail(db, tmdbId, mediaType, language);
  if (!detail) throw error(404, 'No media source configured');
  return json(detail);
};
