import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getSetting } from '$lib/server/settings';
import { usageByModel, spendSince } from '$lib/server/agent/cost';

const WINDOWS: Record<string, number> = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000, all: Infinity };

// GET → cumulative token usage metered by the agent loop (settings.ai_usage).
// GET ?window=24h|7d|30d|all → per-model breakdown + totals + spend for the window.
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const window = url.searchParams.get('window');
  if (!window) {
    const raw = getSetting(db, 'ai_usage');
    return json(raw ? JSON.parse(raw) : { input: 0, output: 0, total: 0 });
  }
  const span = WINDOWS[window] ?? Infinity;
  const since = span === Infinity ? 0 : Date.now() - span;
  const rows = usageByModel(db, since);
  const total = rows.reduce(
    (a, r) => ({ input: a.input + r.input, output: a.output + r.output, cost: a.cost + r.cost }),
    { input: 0, output: 0, cost: 0 }
  );
  return json({ window, rows, total, spend: spendSince(db, since) });
};
