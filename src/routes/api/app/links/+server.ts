import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConnections } from '$lib/server/connections';
import { publicBase } from '$lib/server/public-url';

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
    // Prefer a deploy-pinned public URL for viewer links (e.g. behind a tunnel);
    // falls back to the internal baseUrl when unset. See $lib/server/public-url.
    jellyfin: media ? publicBase(media.type, media.baseUrl) : null,
    seerr: seerr ? publicBase('seerr', seerr.baseUrl) : null
  });
};
