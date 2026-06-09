import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConnections } from '$lib/server/connections';

/**
 * Consumer-gated quick links to the underlying apps a viewer might want to jump to.
 * Returns ONLY the public base URLs of the first enabled Jellyfin/Plex + Seerr
 * connections — no secrets, no internal config. Used by the /app surface to show
 * "Open Jellyfin ▸" / "Open Seerr ▸" hotlinks.
 */
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const conns = listConnections(getDb()).filter((c) => c.enabled);
  const media = conns.find((c) => c.type === 'jellyfin') ?? conns.find((c) => c.type === 'plex');
  const seerr = conns.find((c) => c.type === 'seerr');
  return json({
    jellyfin: media?.baseUrl ?? null,
    seerr: seerr?.baseUrl ?? null
  });
};
