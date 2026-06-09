import { json, error } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getSetting, setSetting } from '$lib/server/settings';
import { getConsumer } from '$lib/server/identity/consumers';
import { createPlexPin, pollPlexPin } from '$lib/server/provisioning/plex';
import { linkPlexAndWatchState, PlexAlreadyLinkedError } from '$lib/server/provisioning/provision';
import type { DB } from '$lib/server/db';

/** Stable per-instance Plex client identifier, generated + persisted on first use. */
function plexClientId(db: DB): string {
  let id = getSetting(db, 'plex_client_id');
  if (!id) {
    id = randomBytes(16).toString('hex');
    setSetting(db, 'plex_client_id', id);
  }
  return id;
}

// POST → start the PIN flow. Returns { id, code, authUrl }.
export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  const pin = await createPlexPin(plexClientId(db));
  return json(pin);
};

// GET ?pinId= → poll. On the first non-null token, link Plex (+ WatchState) for the
// current consumer and report { linked: true }. While pending, { linked: false }.
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const pinId = Number(url.searchParams.get('pinId'));
  if (!Number.isFinite(pinId) || pinId <= 0) throw error(400, 'pinId required');

  const db = getDb();
  const token = await pollPlexPin(pinId, plexClientId(db));
  if (!token) return json({ linked: false });

  const consumer = getConsumer(db, locals.consumer.id);
  if (!consumer) throw error(401, 'Unauthorized');
  try {
    await linkPlexAndWatchState(db, consumer, token, consumer.jellyfinUserId);
  } catch (e) {
    if (e instanceof PlexAlreadyLinkedError) throw error(409, e.message);
    console.error('[app/plex] link failed', e);
    throw error(502, `Plex link failed: ${(e as Error).message}`);
  }
  return json({ linked: true });
};
