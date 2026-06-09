import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getSetting, setSetting } from '$lib/server/settings';

const TYPES = ['container_down', 'disk_high', 'download_stalled'] as const;
type Prefs = Record<(typeof TYPES)[number], boolean>;

function readPrefs(db: ReturnType<typeof getDb>): Prefs {
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(getSetting(db, 'notify_prefs') ?? '{}'); } catch { /* default */ }
  return Object.fromEntries(TYPES.map((t) => [t, stored[t] !== false])) as Prefs; // default true
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  return json({ prefs: readPrefs(getDb()) });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: { prefs?: Record<string, unknown> };
  try { b = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const incoming = b.prefs ?? {};
  const next = Object.fromEntries(TYPES.map((t) => [t, incoming[t] !== false]));
  setSetting(getDb(), 'notify_prefs', JSON.stringify(next));
  return json({ ok: true, prefs: next });
};
