import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getSetting, setSetting } from '$lib/server/settings';

// Public GET (login page reads it). Returns ONLY the contact string — no other settings leaked.
export const GET: RequestHandler = async () => {
  return json({ contact: getSetting(getDb(), 'admin_contact') ?? '' });
};

// Admin-only PUT.
export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: { contact?: string };
  try { b = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  setSetting(getDb(), 'admin_contact', String(b.contact ?? '').slice(0, 200));
  return json({ ok: true });
};
