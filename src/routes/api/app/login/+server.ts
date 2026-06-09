import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { loginConsumer } from '$lib/server/identity/consumer-auth';
import { loginAllowed, recordLoginFailure, recordLoginSuccess } from '$lib/server/ratelimit';
import { logAccess } from '$lib/server/identity/access-log';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const ip = getClientAddress();
  const gate = loginAllowed(ip);
  if (!gate.allowed) throw error(429, `Too many attempts. Retry in ${gate.retryAfterSec}s`);

  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const { username, password } = b ?? {};
  if (!username || !password) throw error(400, 'username and password required');

  const userAgent = request.headers.get('user-agent') ?? undefined;
  try {
    const sid = await loginConsumer(getDb(), username, password, { ip, userAgent });
    recordLoginSuccess(ip);
    cookies.set('pulse_app', sid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 });
    return json({ ok: true });
  } catch (e) {
    recordLoginFailure(ip);
    logAccess(getDb(), { type: 'login_failed', ip, userAgent, detail: String(username).slice(0, 64) });
    console.error('[login] consumer login failed', e);
    throw error(401, 'Login failed.');
  }
};
