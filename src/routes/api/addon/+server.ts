/**
 * Admin API for the inbound Stremio addon token.
 *
 * The token this mints sits in a URL path and is a BEARER credential: whoever holds the URL can
 * browse and stream the whole Jellyfin library and file requests as the attributed consumer. It is
 * therefore returned to the admin page in full (there is no other way to build the install URL),
 * and every verb here is admin-only.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { mintAddonToken, readAddonToken, revokeAddonToken } from '$lib/server/addon/tokens';
import { listConsumers } from '$lib/server/identity/consumers';
import { logAccess } from '$lib/server/identity/access-log';

/** Labels are shown back in the panel; keep them short rather than storing an essay. */
const MAX_LABEL = 80;

function requireAdmin(locals: App.Locals): void {
  // hooks.server.ts already gates every /api/ path on an admin session and 404s the admin surface
  // on PULSE_PUBLIC_HOST. This is defence in depth, matching /api/stremio and /api/users.
  if (!locals.user) throw error(401, 'Unauthorized');
}

export const GET: RequestHandler = async ({ locals }) => {
  requireAdmin(locals);
  const db = getDb();
  const t = readAddonToken(db);
  return json({
    linked: !!t,
    token: t?.token ?? null,
    consumerId: t?.consumerId ?? null,
    label: t?.label ?? null,
    createdAt: t?.createdAt ?? null,
    lastUsedAt: t?.lastUsedAt ?? null,
    consumers: listConsumers(db).map((c) => ({ id: c.id, displayName: c.displayName }))
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  requireAdmin(locals);
  const body = await request.json().catch(() => ({}));
  const consumerId = body?.consumerId;
  if (!Number.isInteger(consumerId)) throw error(400, 'consumerId is required');

  const db = getDb();
  // Validate against the LIVE roster, not just the column type. A token attributed to a consumer
  // that does not exist resolves fine, streams fine, and then 404s on every request action with
  // nothing anywhere to explain why.
  if (!listConsumers(db).some((c) => c.id === consumerId)) throw error(400, 'Unknown consumer');

  const raw = typeof body?.label === 'string' ? body.label.trim().slice(0, MAX_LABEL) : '';
  // `mintAddonToken` revokes any previous token in the same transaction: there is at most one live
  // addon URL, and regenerating kills the old one immediately.
  const token = mintAddonToken(db, { consumerId, label: raw || null });
  logAccess(db, { consumerId, type: 'addon_mint' });
  return json({ ok: true, token });
};

export const DELETE: RequestHandler = async ({ locals }) => {
  requireAdmin(locals);
  const db = getDb();
  revokeAddonToken(db);
  logAccess(db, { consumerId: null, type: 'addon_revoke' });
  return json({ ok: true });
};
