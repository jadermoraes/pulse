import type { Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { login } from '$lib/server/auth';
import { loginAllowed, recordLoginFailure, recordLoginSuccess } from '$lib/server/ratelimit';

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress }) => {
    const ip = getClientAddress();

    const check = loginAllowed(ip);
    if (!check.allowed) {
      const mins = Math.ceil((check.retryAfterSec ?? 900) / 60);
      return fail(429, { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
    }

    const data = await request.formData();
    const sid = login(getDb(), String(data.get('email') ?? ''), String(data.get('password') ?? ''));
    if (!sid) {
      recordLoginFailure(ip);
      return fail(401, { error: 'Invalid email or password.' });
    }

    recordLoginSuccess(ip);
    cookies.set('pulse_session', sid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 });
    throw redirect(303, '/');
  }
};
