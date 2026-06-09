import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getReset, consumeReset } from '$lib/server/identity/password-reset';
import { getConsumer } from '$lib/server/identity/consumers';
import { listConnections } from '$lib/server/connections';
import { setJellyfinPassword } from '$lib/server/provisioning/jellyfin';
import { loginConsumer } from '$lib/server/identity/consumer-auth';
import { logAccess } from '$lib/server/identity/access-log';
import { loginAllowed, recordLoginFailure, recordLoginSuccess } from '$lib/server/ratelimit';
import { validatePassword } from '$lib/consumer/validate';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const ip = getClientAddress();
  const gate = loginAllowed(ip);
  if (!gate.allowed) throw error(429, `Too many attempts. Retry in ${gate.retryAfterSec}s`);

  let b: { token?: string; password?: string };
  try { b = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const token = String(b.token ?? '');
  const password = typeof b.password === 'string' ? b.password : '';
  const pwErr = validatePassword(password);
  if (pwErr) throw error(400, pwErr);

  const db = getDb();
  const reset = getReset(db, token);
  if (!reset) { recordLoginFailure(ip); throw error(400, 'This reset link is invalid or has expired.'); }
  const consumer = getConsumer(db, reset.consumerId);
  if (!consumer?.jellyfinUserId) throw error(400, 'This account can no longer be reset — contact your admin.');

  const jf = listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled);
  if (!jf) throw error(502, 'Password reset is unavailable right now.');
  try {
    await setJellyfinPassword(jf, consumer.jellyfinUserId, password); // throws ⇒ token NOT consumed (retryable)
  } catch (e) {
    console.error('[reset] jellyfin set-password failed', e);
    throw error(502, 'Could not update your password — please try again.');
  }
  consumeReset(db, token);
  recordLoginSuccess(ip);
  logAccess(db, { consumerId: consumer.id, type: 'password_reset', ip, userAgent: request.headers.get('user-agent') ?? undefined, detail: 'completed' });

  // Auto-login is best-effort: use the stored Jellyfin username (persisted at provision time)
  // for reliable authentication; fall back to displayName for legacy consumers provisioned
  // before this field was introduced (they will have jellyfinUsername = null).
  try {
    const sid = await loginConsumer(db, consumer.jellyfinUsername ?? consumer.displayName, password, { ip, userAgent: request.headers.get('user-agent') ?? undefined });
    cookies.set('pulse_app', sid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 });
  } catch {
    /* password set OK; manual sign-in still works */
  }
  return json({ ok: true });
};
