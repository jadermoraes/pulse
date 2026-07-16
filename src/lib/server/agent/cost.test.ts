import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { priceFor, estimateCost, recordUsage, usageByModel, spendSince } from './cost';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

it('priceFor matches known models by prefix and defaults unknown to zero', () => {
  expect(priceFor('claude-sonnet-4-6')).toEqual({ inPerM: 3, outPerM: 15 });
  expect(priceFor('claude-haiku-4-5-20251001').inPerM).toBeLessThan(3);
  expect(priceFor('some-unknown-model')).toEqual({ inPerM: 0, outPerM: 0 });
});

it('estimateCost computes USD from token counts', () => {
  expect(estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18, 5);
  expect(estimateCost('claude-sonnet-4-6', 1000, 0)).toBeCloseTo(0.003, 6);
});

it('estimateCost bills cached input tokens at 10% of the input rate', () => {
  // All 1M input tokens came from cache reads → 1M × $3/M × 0.1 = $0.30.
  expect(estimateCost('claude-sonnet-4-6', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.3, 5);
  // Half cached: 500k × $3/M + 500k × $0.3/M = $1.65.
  expect(estimateCost('claude-sonnet-4-6', 1_000_000, 0, 500_000)).toBeCloseTo(1.65, 5);
  // No cached tokens → unchanged legacy behavior.
  expect(estimateCost('claude-sonnet-4-6', 1_000_000, 0, 0)).toBeCloseTo(3, 5);
});

it('recordUsage logs total input tokens but bills cached ones at the discounted rate', () => {
  const cost = recordUsage(db, { model: 'claude-sonnet-4-6', input: 1_000_000, output: 0, cached: 1_000_000 });
  expect(cost).toBeCloseTo(0.3, 5);
  const rows = usageByModel(db, 0);
  expect(rows[0].input).toBe(1_000_000); // analytics still see the full input volume
});

it('recordUsage inserts a log row with computed cost', () => {
  const cost = recordUsage(db, { model: 'claude-sonnet-4-6', input: 1000, output: 1000 });
  expect(cost).toBeCloseTo(0.018, 6);
  const rows = usageByModel(db, 0);
  expect(rows).toEqual([{ model: 'claude-sonnet-4-6', input: 1000, output: 1000, cost: cost }]);
});

it('usageByModel groups + spendSince sums within a window', () => {
  recordUsage(db, { model: 'claude-sonnet-4-6', input: 1000, output: 0 });
  recordUsage(db, { model: 'claude-sonnet-4-6', input: 1000, output: 0 });
  recordUsage(db, { model: 'gpt-4o-mini', input: 1000, output: 0 });
  const rows = usageByModel(db, 0);
  expect(rows.find((r) => r.model === 'claude-sonnet-4-6')!.input).toBe(2000);
  expect(rows).toHaveLength(2);
  expect(spendSince(db, 0)).toBeGreaterThan(0);
  expect(spendSince(db, Date.now() + 100000)).toBe(0);
});
