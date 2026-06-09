import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listRoles, createRole, updateRole, deleteRole } from '$lib/server/identity/roles';
import { CAPABILITIES, type Capability } from '$lib/server/identity/types';

function cleanAllow(v: unknown): Capability[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Capability => CAPABILITIES.includes(x as Capability));
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  return json({ roles: listRoles(getDb()) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  if (!b.name || typeof b.name !== 'string') throw error(400, 'name required');
  const cap = b.monthlyTokenCap == null ? null : Number(b.monthlyTokenCap);
  if (cap != null && Number.isNaN(cap)) throw error(400, 'Invalid cap');
  try {
    const id = createRole(getDb(), {
      name: b.name,
      allowList: cleanAllow(b.allowList),
      monthlyTokenCap: cap,
      planName: typeof b.planName === 'string' ? b.planName : null,
      autoApprove: Boolean(b.autoApprove),
      seerrQuota: b.seerrQuota ?? {}
    });
    return json({ id }, { status: 201 });
  } catch (e) {
    throw error(400, (e as Error).message);
  }
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  if (!b.id) throw error(400, 'id required');
  let cap: number | null | undefined;
  if ('monthlyTokenCap' in b) {
    cap = b.monthlyTokenCap == null ? null : Number(b.monthlyTokenCap);
    if (cap != null && Number.isNaN(cap)) throw error(400, 'Invalid cap');
  }
  try {
    updateRole(getDb(), Number(b.id), {
      name: b.name,
      allowList: b.allowList ? cleanAllow(b.allowList) : undefined,
      monthlyTokenCap: cap,
      planName: 'planName' in b ? (typeof b.planName === 'string' ? b.planName : null) : undefined,
      autoApprove: b.autoApprove,
      seerrQuota: b.seerrQuota
    });
    return json({ ok: true });
  } catch (e) {
    throw error(400, (e as Error).message);
  }
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
  try {
    deleteRole(getDb(), Number(b.id));
    return json({ ok: true });
  } catch (e) {
    throw error(400, (e as Error).message);
  }
};
