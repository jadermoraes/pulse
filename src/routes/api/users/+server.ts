import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import {
  listConsumers,
  updateConsumer,
  setStatus,
  deleteConsumer,
  getConsumer,
  effectiveCap as effCap
} from '$lib/server/identity/consumers';
import { getRole } from '$lib/server/identity/roles';
import { monthToDate } from '$lib/server/identity/usage';
import { CAPABILITIES, type Capability } from '$lib/server/identity/types';
import { deprovisionConsumer } from '$lib/server/provisioning/provision';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const users = listConsumers(db).map((c) => {
    const role = getRole(db, c.roleId);
    return {
      id: c.id,
      displayName: c.displayName,
      roleId: c.roleId,
      roleName: role?.name ?? '?',
      status: c.status,
      language: c.language,
      capOverride: c.capOverride,
      allowOverride: c.allowOverride,
      monthToDate: monthToDate(db, c.id),
      effectiveCap: role ? effCap(c, role) : null
    };
  });
  return json({ users });
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  if (!b.id) throw error(400, 'id required');
  const db = getDb();
  if (!getConsumer(db, Number(b.id))) throw error(404, 'Not found');
  if (b.status === 'disabled' || b.status === 'active') setStatus(db, Number(b.id), b.status);
  const patch: any = {};
  if (b.roleId != null) {
    const roleId = Number(b.roleId);
    const role = getRole(db, roleId);
    if (!role || role.isAdmin) throw error(400, 'Cannot assign the Admin role');
    patch.roleId = roleId;
  }
  if ('capOverride' in b) patch.capOverride = b.capOverride == null ? null : Number(b.capOverride);
  if ('allowOverride' in b) {
    patch.allowOverride =
      b.allowOverride == null
        ? null
        : (b.allowOverride as unknown[]).filter((x): x is Capability =>
            CAPABILITIES.includes(x as Capability)
          );
  }
  if (Object.keys(patch).length) updateConsumer(db, Number(b.id), patch);
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  if (!b.id) throw error(400, 'id required');
  const db = getDb();
  const consumer = getConsumer(db, Number(b.id));
  // If the consumer doesn't exist, behave as today (no-op, success).
  if (!consumer) return json({ ok: true, warnings: [] });
  // Best-effort de-provision downstream accounts before removing the Pulse record.
  const { warnings } = await deprovisionConsumer(db, consumer);
  // Cascade drops sessions + usage counters.
  deleteConsumer(db, Number(b.id));
  return json({ ok: true, warnings });
};
