import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setSetting } from '$lib/server/settings';
import { GRID_COLUMNS, type SavedLayoutEntry } from '$lib/dashboard';

const LAYOUT_KEY = 'dashboard_layout';

/** Coerce to a finite integer, or undefined. */
function int(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Lightly validate one layout entry on the GridStack x/y/w/h model; returns a
 * normalized entry or null if invalid. x/y are optional (auto-placed widgets).
 */
function normalize(e: unknown): SavedLayoutEntry | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  if (typeof o.key !== 'string' || !o.key) return null;

  const w = int(o.w);
  const h = int(o.h);
  if (w === undefined || h === undefined) return null;

  const entry: SavedLayoutEntry = {
    key: o.key,
    w: Math.min(Math.max(w, 1), GRID_COLUMNS),
    h: Math.max(h, 1),
    visible: o.visible !== false,
    collapsed: o.collapsed === true
  };
  const x = int(o.x);
  const y = int(o.y);
  if (x !== undefined && x >= 0) entry.x = x;
  if (y !== undefined && y >= 0) entry.y = y;
  return entry;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  if (!Array.isArray(body)) throw error(400, 'Expected an array');

  const layout: SavedLayoutEntry[] = [];
  for (const e of body) {
    const n = normalize(e);
    if (!n) throw error(400, 'Invalid layout entry');
    layout.push(n);
  }

  setSetting(getDb(), LAYOUT_KEY, JSON.stringify(layout));
  return json({ ok: true });
};
