import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getCostLimits, setCostLimits } from '$lib/server/agent/cost-guard';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  return json(getCostLimits(getDb()));
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let b: Record<string, unknown>;
  try { b = await request.json(); } catch { throw error(400, 'Invalid JSON'); }
  const num = (v: unknown) => (typeof v === 'number' && v >= 0 && isFinite(v) ? v : undefined);
  const patch: Partial<Record<string, number>> = {};
  for (const k of ['rapidHourUsd', 'dailyUsd', 'monthlyUsd', 'perTurnUsd', 'perTurnSteps'] as const) {
    const v = num(b[k]); if (v !== undefined) patch[k] = v;
  }
  setCostLimits(getDb(), patch);
  return json(getCostLimits(getDb()));
};
