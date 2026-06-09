import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listAccess, describeDevice } from '$lib/server/identity/access-log';
import { listConsumers } from '$lib/server/identity/consumers';

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const consumerId = url.searchParams.get('consumerId');
  const before = url.searchParams.get('before');
  const limit = url.searchParams.get('limit');
  const names = new Map(listConsumers(db).map((c) => [c.id, c.displayName]));
  const events = listAccess(db, {
    consumerId: consumerId ? Number(consumerId) : undefined,
    before: before ? Number(before) : undefined,
    limit: limit ? Number(limit) : 50
  }).map((e) => ({
    ...e,
    displayName: e.consumerId != null ? names.get(e.consumerId) ?? '?' : null,
    device: describeDevice(e.userAgent)
  }));
  return json({ events });
};
