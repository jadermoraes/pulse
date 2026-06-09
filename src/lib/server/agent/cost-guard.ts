import type { DB } from '../db';
import { getSetting, setSetting } from '../settings';
import { recordEvent } from './events';
import { notifyAdmins } from '../notify';
import { spendSince } from './cost';

export interface CostLimits {
  rapidHourUsd: number; dailyUsd: number; monthlyUsd: number; perTurnUsd: number; perTurnSteps: number;
}
const DEFAULTS: CostLimits = { rapidHourUsd: 2, dailyUsd: 5, monthlyUsd: 20, perTurnUsd: 0.5, perTurnSteps: 8 };
const KEY = 'ai_cost_limits';

export function getCostLimits(db: DB): CostLimits {
  try { const raw = getSetting(db, KEY); if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }; } catch { /* default */ }
  return { ...DEFAULTS };
}
export function setCostLimits(db: DB, limits: Partial<CostLimits>): void {
  setSetting(db, KEY, JSON.stringify({ ...getCostLimits(db), ...limits }));
}

function startOfDay(now: number): number { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfMonth(now: number): number { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Evaluate all guardrails after a turn. Warn-only: deduped warn/crit events. Best-effort (never throws). */
export function checkGuards(db: DB, turnCostUsd: number, turnSteps: number, now: number = Date.now()): void {
  try {
    const lim = getCostLimits(db);
    const fire = (severity: 'warn' | 'crit', dedupeKey: string, title: string, body: string, onceEver = false) => {
      const id = recordEvent(db, { source: 'ai-cost', type: 'cost_alert', severity, title, body, dedupeKey, onceEver });
      if (id) void notifyAdmins(db, { title, body }).catch(() => { /* best-effort */ });
      return id;
    };

    if (lim.rapidHourUsd > 0) {
      const h = spendSince(db, now - 3_600_000);
      if (h > lim.rapidHourUsd) fire('warn', 'cost:rapid', 'AI spend spike', `$${h.toFixed(2)} spent in the last hour (limit $${lim.rapidHourUsd}).`);
    }
    if (lim.dailyUsd > 0) {
      const d = spendSince(db, startOfDay(now));
      if (d > lim.dailyUsd) fire('warn', `cost:daily:${dayKey(now)}`, 'AI daily budget exceeded', `$${d.toFixed(2)} spent today (limit $${lim.dailyUsd}).`, true);
    }
    if (lim.monthlyUsd > 0) {
      const mo = spendSince(db, startOfMonth(now));
      if (mo >= lim.monthlyUsd) fire('crit', `cost:month:${monthKey(now)}:100`, 'AI monthly budget reached', `$${mo.toFixed(2)} this month (budget $${lim.monthlyUsd}).`, true);
      else if (mo >= lim.monthlyUsd * 0.8) fire('warn', `cost:month:${monthKey(now)}:80`, 'AI monthly budget at 80%', `$${mo.toFixed(2)} this month (budget $${lim.monthlyUsd}).`, true);
    }
    if ((lim.perTurnUsd > 0 && turnCostUsd > lim.perTurnUsd) || (lim.perTurnSteps > 0 && turnSteps > lim.perTurnSteps)) {
      fire('warn', 'cost:turn', 'Expensive AI turn', `One turn used $${turnCostUsd.toFixed(2)} / ${turnSteps} steps.`);
    }
  } catch { /* best-effort */ }
}
