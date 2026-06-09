import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getConsumer, effectiveAllowList, effectiveCap } from '$lib/server/identity/consumers';
import { getRole } from '$lib/server/identity/roles';
import { monthToDate, daysUntilReset } from '$lib/server/identity/usage';
import { capToPlan } from '$lib/server/consumer/plan';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  const c = getConsumer(db, locals.consumer.id);
  if (!c) throw error(401, 'Unauthorized');
  const role = getRole(db, c.roleId)!;
  const cap = effectiveCap(c, role);
  return json({
    displayName: c.displayName,
    language: c.language,
    roleName: role.name,
    allowList: effectiveAllowList(c, role),
    monthToDate: monthToDate(db, c.id),
    cap,
    planName: role.planName ?? capToPlan(cap), // role's named tier, else inferred from the effective cap
    daysUntilReset: daysUntilReset(),
    plexLinked: c.plexAccountId != null // B.2 placeholder
  });
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  // Consumers may only change their own language (self-scoped), and only to a known locale.
  const LOCALES = ['en', 'pt-BR'];
  if (typeof b.language === 'string') {
    if (!LOCALES.includes(b.language)) throw error(400, 'Unsupported language');
    getDb().prepare('update consumer_users set language=? where id=?').run(b.language, locals.consumer.id);
  }
  return json({ ok: true });
};
