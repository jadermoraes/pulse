import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConsumerSessions, revokeConsumerSession } from '$lib/server/identity/consumer-auth';
import { describeDevice } from '$lib/server/identity/access-log';

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const consumerId = Number(url.searchParams.get('consumerId'));
  if (!consumerId || isNaN(consumerId)) throw error(400, 'consumerId required');
  const db = getDb();
  const sessions = listConsumerSessions(db, consumerId).map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    ip: s.ip,
    device: describeDevice(s.userAgent)
  }));
  return json({ sessions });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  if (!b.id) throw error(400, 'id required');
  const db = getDb();
  revokeConsumerSession(db, String(b.id));
  return json({ ok: true });
};
