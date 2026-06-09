import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { resolveDetail } from '$lib/server/actions';

// GET /api/detail/<connectionId>?kind=&id=&tmdbId=&mediaType=&movieId=&seriesId=&fromQueue=
// Auth-gated. Returns the MediaDetail JSON (never any secret). 404 if the
// integration has no `detail`; a fallback (not a 500) on upstream failure.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');

  const id = Number(params.connectionId);
  if (!Number.isFinite(id)) throw error(400, 'Bad connection id');

  // Pass every query param straight through to the integration's detail().
  const detailParams: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams.entries()) detailParams[k] = v;

  const res = await resolveDetail(getDb(), id, detailParams);
  if (!res.ok) throw error(res.status, res.message);
  return json(res.detail);
};
