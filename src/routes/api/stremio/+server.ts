import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { stremioLogin, StremioError } from '$lib/server/integrations/stremio';
import {
  readHousehold, saveStremioConnection, setParticipants, unlinkStremio
} from '$lib/server/consumer/household-stremio';
import { listConsumers } from '$lib/server/identity/consumers';
import { logAccess } from '$lib/server/identity/access-log';
import { rateLimit } from '$lib/server/request-limit';

function requireAdmin(locals: App.Locals): void {
  // hooks.server.ts already gates every /api/ path on an admin session and 404s the admin
  // surface on PULSE_PUBLIC_HOST. This is defence in depth, matching /api/users.
  if (!locals.user) throw error(401, 'Unauthorized');
}

export const GET: RequestHandler = async ({ locals }) => {
  requireAdmin(locals);
  const db = getDb();
  const h = readHousehold(db);
  return json({
    linked: !!h,
    enabled: h?.connection.enabled ?? false,
    email: h?.email ?? '',
    participantIds: h?.participantIds ?? [],
    lastSyncAt: h?.lastSyncAt ?? null,
    lastError: h?.lastError ?? null,
    consumers: listConsumers(db).map((c) => ({ id: c.id, displayName: c.displayName }))
  });
};

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
  requireAdmin(locals);
  // An endpoint that takes a password must not be free to hammer. `rateLimit` RETURNS a result,
  // it does not throw.
  const limit = rateLimit(`stremio-household-link:${getClientAddress()}`, 5, 60_000);
  if (!limit.ok) throw error(429, `Too many attempts. Try again in ${limit.retryAfter}s.`);

  const body = await request.json().catch(() => ({}));
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) throw error(400, 'Email and password are required');

  let authKey: string;
  try {
    // The password is used for exactly this call and is never stored, logged, or echoed.
    authKey = await stremioLogin(email, password);
  } catch (e) {
    if (e instanceof StremioError) throw error(400, 'Stremio rejected those credentials');
    throw error(502, 'Could not reach Stremio');
  }

  const db = getDb();
  saveStremioConnection(db, { email, authKey });
  logAccess(db, { consumerId: null, type: 'stremio_link' });
  return json({ ok: true });
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
  requireAdmin(locals);
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body?.participantIds)) throw error(400, 'participantIds must be an array');

  const db = getDb();
  // Filter against the real roster here as well as on read: a stale id in the stored blob is
  // tolerated (users get deleted), but there is no reason to write one in.
  const live = new Set(listConsumers(db).map((c) => c.id));
  // Dedupe as well as filter, matching `setParticipants`: otherwise `[2,2]` stores `[2]` but the
  // route echoes `[2,2]`, so the response disagrees with what was written.
  const ids = [...new Set((body.participantIds as unknown[])
    .filter((v): v is number => Number.isInteger(v) && live.has(v as number)))];

  setParticipants(db, ids);
  return json({ ok: true, participantIds: ids });
};

export const DELETE: RequestHandler = async ({ locals }) => {
  requireAdmin(locals);
  const db = getDb();
  unlinkStremio(db);
  logAccess(db, { consumerId: null, type: 'stremio_unlink' });
  return json({ ok: true });
};
