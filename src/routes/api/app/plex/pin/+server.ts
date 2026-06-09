import { json, error } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getSetting, setSetting } from '$lib/server/settings';
import { createPlexPin, pollPlexPin } from '$lib/server/provisioning/plex';
import { loginAllowed, recordLoginFailure } from '$lib/server/ratelimit';
import type { DB } from '$lib/server/db';

/**
 * Public (pre-onboarding) Plex PIN endpoint used by the join wizard. Unlike /api/app/plex it is
 * NOT consumer-gated (the consumer does not exist yet) and it returns the raw token so the wizard
 * can include it in the join payload — the actual Plex/WatchState link then runs server-side inside
 * provisionConsumer (best-effort, degrades on failure). It only ever creates/polls a PIN; it never
 * mutates any account, so exposing it unauthenticated is safe.
 */
function plexClientId(db: DB): string {
  let id = getSetting(db, 'plex_client_id');
  if (!id) {
    id = randomBytes(16).toString('hex');
    setSetting(db, 'plex_client_id', id);
  }
  return id;
}

// POST → start the PIN flow. Returns { id, code, authUrl }.
export const POST: RequestHandler = async ({ getClientAddress }) => {
  const ip = getClientAddress();
  const gate = loginAllowed(ip);
  if (!gate.allowed) throw error(429, `Too many attempts. Retry in ${gate.retryAfterSec}s`);
  // PIN creation is lightweight but public — record a failure counter on each call so that
  // a scraper that hammers the endpoint accumulates failures and eventually hits the lock.
  // (We intentionally do NOT record a success here; the actual auth is Plex-side.)
  recordLoginFailure(ip);
  const db = getDb();
  const pin = await createPlexPin(plexClientId(db));
  return json(pin);
};

// GET ?pinId= → poll. Returns { token: string | null }.
export const GET: RequestHandler = async ({ url }) => {
  const pinId = Number(url.searchParams.get('pinId'));
  if (!Number.isFinite(pinId) || pinId <= 0) throw error(400, 'pinId required');
  const db = getDb();
  const token = await pollPlexPin(pinId, plexClientId(db));
  return json({ token: token ?? null });
};
