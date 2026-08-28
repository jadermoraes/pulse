import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requestDeviceCode, pollDeviceToken, traktConfigured } from '$lib/server/integrations/trakt';
import { saveCredential, getCredential, deleteCredential } from '$lib/server/consumer/spoke-credentials';
import { logAccess } from '$lib/server/identity/access-log';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const c = getCredential(getDb(), locals.consumer.id, 'trakt');
  return json({
    configured: traktConfigured(),
    linked: !!c,
    enabled: c?.enabled ?? false,
    lastSyncAt: c?.lastSyncAt ?? null,
    lastError: c?.lastError ?? null
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  if (!traktConfigured()) throw error(503, 'Trakt is not configured on this server');

  const body = await request.json().catch(() => ({}));

  if (body?.action === 'start') {
    const d = await requestDeviceCode();
    // The device code is a short-lived, single-use handle; it is returned to the caller and
    // never persisted server-side.
    return json({ deviceCode: d.deviceCode, userCode: d.userCode, verificationUrl: d.verificationUrl, interval: d.interval });
  }

  if (body?.action === 'poll' && typeof body.deviceCode === 'string') {
    const r = await pollDeviceToken(body.deviceCode);
    if (r.status === 'ok') {
      saveCredential(getDb(), {
        consumerId: locals.consumer.id, spoke: 'trakt',
        secret: r.accessToken, refresh: r.refreshToken, expiresAt: r.expiresAt
      });
      logAccess(getDb(), { consumerId: locals.consumer.id, type: 'trakt_link' });
      return json({ status: 'ok' });
    }
    return json({ status: r.status });
  }

  throw error(400, 'Bad request');
};

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  deleteCredential(getDb(), locals.consumer.id, 'trakt');
  logAccess(getDb(), { consumerId: locals.consumer.id, type: 'trakt_unlink' });
  return json({ ok: true });
};
