import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getServiceLinks, setServiceLinks } from '$lib/server/services-launcher';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const links = await getServiceLinks(getDb());
  return json({ links });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b?.links)) throw error(400, 'Expected { links: [] }');
  setServiceLinks(getDb(), b.links as unknown[]);
  return json({ ok: true });
};
