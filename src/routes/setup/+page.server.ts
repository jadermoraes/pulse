import type { Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { createAdmin, isSetup, login } from '$lib/server/auth';

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const db = getDb();
    if (isSetup(db)) throw redirect(303, '/login');
    const data = await request.formData();
    const email = String(data.get('email') ?? '').trim();
    const pw = String(data.get('password') ?? '');
    if (!email.includes('@') || pw.length < 8)
      return fail(400, { error: 'Valid email and 8+ char password required.' });
    createAdmin(db, email, pw);
    const sid = login(db, email, pw)!;
    cookies.set('pulse_session', sid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 });
    throw redirect(303, '/');
  }
};
