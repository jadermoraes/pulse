import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { datastoreGet } from '$lib/server/integrations/stremio';
import { getStremioConnection } from '$lib/server/consumer/household-stremio';

/**
 * Probe the live Library and report what came back.
 *
 * The count is the point, not a health tick. `datastoreGet` asks for `all: true` against an
 * undocumented endpoint; if Stremio ever paginates, a title outside the page reads as absent,
 * gets re-pushed from a borrowed template with `state` zeroed, and `datastorePut` is a full
 * document replace — real cross-device watch progress would be destroyed. Comparing this number
 * against what the TV actually shows is the cheapest way to know that has not happened.
 */
export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const conn = getStremioConnection(getDb());
  if (!conn || !conn.secret) throw error(400, 'Stremio is not linked');
  try {
    const items = await datastoreGet(conn.secret);
    return json({ ok: true, total: items.length, active: items.filter((i) => !i.removed).length });
  } catch (e) {
    // Two message sources, and only one is ours: `Stremio HTTP <status>` is code-constructed and
    // deliberately omits the request body (which carries the authKey). The in-200 error envelope
    // path forwards Stremio's OWN text verbatim, so this is safe because Stremio does not echo the
    // key back, not because we stripped it. If that ever changes, filter here.
    return json({ ok: false, message: (e as Error).message });
  }
};
