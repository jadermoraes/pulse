import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listInvites, mintInvite, deleteInvite } from '$lib/server/identity/invites';
import { getRole } from '$lib/server/identity/roles';

function buildLink(token: string): string {
  const base = (process.env.PULSE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/app/join/${token}` : `/app/join/${token}`;
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const now = Date.now();
  const invites = listInvites(db).map((i) => ({
    id: i.id,
    token: i.token,
    roleId: i.roleId,
    roleName: getRole(db, i.roleId)?.name ?? '?',
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt,
    status: i.acceptedAt ? 'accepted' : i.expiresAt < now ? 'expired' : 'pending',
    link: buildLink(i.token)
  }));
  return json({ invites });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  if (!b.roleId) throw error(400, 'roleId required');
  const db = getDb();
  const role = getRole(db, Number(b.roleId));
  if (!role) throw error(400, 'Unknown role');
  if (role.isAdmin) throw error(400, 'Cannot invite into the Admin role');
  const inv = mintInvite(db, Number(b.roleId), locals.user.id);
  // Prefer an absolute link on the public origin so the admin can send it to invitees as-is;
  // fall back to a relative path when PULSE_PUBLIC_URL is unset (LAN-only deploys).
  const link = buildLink(inv.token);
  return json({ token: inv.token, link, expiresAt: inv.expiresAt }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: { id?: number };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  if (body.id == null) throw error(400, 'id required');
  const db = getDb();
  deleteInvite(db, body.id);
  return json({ ok: true });
};
