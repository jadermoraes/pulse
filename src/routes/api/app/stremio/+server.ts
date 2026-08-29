import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { stremioLogin, StremioError } from '$lib/server/integrations/stremio';
import { saveCredential, getCredential, deleteCredential } from '$lib/server/consumer/spoke-credentials';
import { logAccess } from '$lib/server/identity/access-log';
import { rateLimit } from '$lib/server/request-limit';
import { getConsumer, effectiveAllowList } from '$lib/server/identity/consumers';
import { getRole } from '$lib/server/identity/roles';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const c = getCredential(getDb(), locals.consumer.id, 'stremio');
  return json({
    linked: !!c,
    enabled: c?.enabled ?? false,
    lastSyncAt: c?.lastSyncAt ?? null,
    lastError: c?.lastError ?? null
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  // Gated on the EXISTING `watchlist` capability — Stremio sync is a watchlist feature, so it
  // does not widen the Capability union or the roles UI. This is the same resolution
  // `/api/app/me` uses: a per-user override wins, else the role's allow-list.
  const db = getDb();
  const c = getConsumer(db, locals.consumer.id);
  if (!c) throw error(401, 'Unauthorized');
  const role = getRole(db, c.roleId)!;
  if (!effectiveAllowList(c, role).includes('watchlist')) throw error(403, 'Forbidden');

  // A login endpoint that takes a password must not be free to hammer. `rateLimit` RETURNS a
  // result, it does not throw.
  const limit = rateLimit(`stremio-link:${locals.consumer.id}`, 5, 60_000);
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

  saveCredential(db, { consumerId: locals.consumer.id, spoke: 'stremio', secret: authKey });
  logAccess(db, { consumerId: locals.consumer.id, type: 'stremio_link' });
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  deleteCredential(getDb(), locals.consumer.id, 'stremio');
  logAccess(getDb(), { consumerId: locals.consumer.id, type: 'stremio_unlink' });
  return json({ ok: true });
};
