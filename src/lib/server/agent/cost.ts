import type { DB } from '../db';
import { getSetting, setSetting } from '../settings';

export interface Price { inPerM: number; outPerM: number }

// USD per 1M tokens. Order matters — more specific 'haiku'/'mini' matched before broad ones.
const PRICING: Array<{ match: string; price: Price }> = [
  { match: 'claude-opus', price: { inPerM: 15, outPerM: 75 } },
  { match: 'claude-sonnet', price: { inPerM: 3, outPerM: 15 } },
  { match: 'claude-3-5-haiku', price: { inPerM: 0.8, outPerM: 4 } },
  { match: 'claude-haiku', price: { inPerM: 0.8, outPerM: 4 } },
  { match: 'gpt-4o-mini', price: { inPerM: 0.15, outPerM: 0.6 } },
  { match: 'gpt-4o', price: { inPerM: 2.5, outPerM: 10 } }
];

export function priceFor(model: string): Price {
  const m = (model || '').toLowerCase();
  for (const p of PRICING) if (m.includes(p.match)) return p.price;
  return { inPerM: 0, outPerM: 0 };
}

export function estimateCost(model: string, input: number, output: number): number {
  const p = priceFor(model);
  return (input / 1_000_000) * p.inPerM + (output / 1_000_000) * p.outPerM;
}

/** Append a usage row, return the row's estimated cost (USD). Also bumps the legacy ai_usage lump. */
export function recordUsage(db: DB, u: { model: string; input: number; output: number }): number {
  const cost = estimateCost(u.model, u.input, u.output);
  db.prepare('INSERT INTO ai_usage_log(ts, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?)')
    .run(Date.now(), u.model || 'unknown', u.input, u.output, cost);
  try {
    // Atomic read-modify-write: wrap get→add→set in one transaction so two turns metering
    // concurrently can't both read the same `prev` and lose an increment.
    const tx = db.transaction(() => {
      const prev = JSON.parse(getSetting(db, 'ai_usage') ?? '{"input":0,"output":0,"total":0}');
      setSetting(db, 'ai_usage', JSON.stringify({
        input: prev.input + u.input, output: prev.output + u.output, total: prev.total + u.input + u.output
      }));
    });
    tx();
  } catch { /* lump is best-effort */ }
  return cost;
}

export interface ModelUsage { model: string; input: number; output: number; cost: number }

export function usageByModel(db: DB, sinceTs: number): ModelUsage[] {
  return (db.prepare(
    `SELECT model, SUM(input_tokens) input, SUM(output_tokens) output, SUM(cost_usd) cost
       FROM ai_usage_log WHERE ts >= ? GROUP BY model ORDER BY cost DESC`
  ).all(sinceTs) as any[]).map((r) => ({ model: r.model, input: r.input, output: r.output, cost: r.cost }));
}

export function spendSince(db: DB, sinceTs: number): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM ai_usage_log WHERE ts >= ?').get(sinceTs) as any;
  return r.c as number;
}
