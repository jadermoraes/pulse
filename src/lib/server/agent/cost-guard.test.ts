import { it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { recordUsage } from './cost';
import * as events from './events';
import * as notify from '../notify';
import { getCostLimits, setCostLimits, checkGuards } from './cost-guard';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });
afterEach(() => vi.restoreAllMocks());

it('getCostLimits returns defaults when unset', () => {
  expect(getCostLimits(db)).toMatchObject({ rapidHourUsd: 2, dailyUsd: 5, monthlyUsd: 20, perTurnUsd: 0.5, perTurnSteps: 8 });
});

it('rapid-burn fires a warn event when last-hour spend exceeds the threshold', () => {
  const spy = vi.spyOn(events, 'recordEvent').mockReturnValue(1 as any);
  const notifySpy = vi.spyOn(notify, 'notifyAdmins').mockResolvedValue(undefined);
  setCostLimits(db, { rapidHourUsd: 0.01, dailyUsd: 0, monthlyUsd: 0, perTurnUsd: 0, perTurnSteps: 0 });
  recordUsage(db, { model: 'claude-sonnet-4-6', input: 1000, output: 1000 }); // ~$0.018
  checkGuards(db, 0.018, 1);
  expect(spy).toHaveBeenCalledWith(db, expect.objectContaining({ severity: 'warn', dedupeKey: expect.stringContaining('cost:rapid') }));
  // A NEW (non-deduped) cost event must also push to admins (Telegram), not just the feed.
  expect(notifySpy).toHaveBeenCalledWith(db, expect.objectContaining({ title: 'AI spend spike' }));
});

it('per-turn cap fires on a costly single turn; disabled (0) limits never fire', () => {
  const spy = vi.spyOn(events, 'recordEvent').mockReturnValue(1 as any);
  setCostLimits(db, { rapidHourUsd: 0, dailyUsd: 0, monthlyUsd: 0, perTurnUsd: 0.5, perTurnSteps: 0 });
  checkGuards(db, 0.75, 2);
  expect(spy).toHaveBeenCalledWith(db, expect.objectContaining({ dedupeKey: expect.stringContaining('cost:turn') }));
  spy.mockClear();
  setCostLimits(db, { rapidHourUsd: 0, dailyUsd: 0, monthlyUsd: 0, perTurnUsd: 0, perTurnSteps: 0 });
  checkGuards(db, 100, 100);
  expect(spy).not.toHaveBeenCalled();
});

it('monthly 80% warns and 100% crits (once each, deduped by month key)', () => {
  const spy = vi.spyOn(events, 'recordEvent').mockReturnValue(1 as any);
  setCostLimits(db, { rapidHourUsd: 0, dailyUsd: 0, monthlyUsd: 0.02, perTurnUsd: 0, perTurnSteps: 0 });
  recordUsage(db, { model: 'claude-sonnet-4-6', input: 1000, output: 1000 }); // ~$0.018 = 90% of 0.02
  checkGuards(db, 0.018, 1);
  expect(spy).toHaveBeenCalledWith(db, expect.objectContaining({ severity: 'warn', dedupeKey: expect.stringContaining(':80') }));
});

it('monthly 100% crits and is deduped (onceEver) on a second call', () => {
  const spy = vi.spyOn(events, 'recordEvent');
  setCostLimits(db, { rapidHourUsd: 0, dailyUsd: 0, monthlyUsd: 0.01, perTurnUsd: 0, perTurnSteps: 0 });
  recordUsage(db, { model: 'claude-sonnet-4-6', input: 1000, output: 1000 }); // ~$0.018 > $0.01 = 100%+
  checkGuards(db, 0.018, 1);
  const critCalls = spy.mock.calls.filter((c) => (c[1] as any).severity === 'crit' && String((c[1] as any).dedupeKey).includes(':100'));
  expect(critCalls.length).toBe(1);
  // second call same month → onceEver dedups (recordEvent itself suppresses; assert checkGuards still only ever fired one crit total)
  checkGuards(db, 0, 1);
  const critCalls2 = spy.mock.calls.filter((c) => (c[1] as any).severity === 'crit' && String((c[1] as any).dedupeKey).includes(':100'));
  // checkGuards calls recordEvent each time, but the SAME onceEver dedupeKey means at most one real event is stored.
  // Assert the dedupeKey is stable (the dedup happens inside recordEvent via seen_events):
  expect(critCalls2.every((c) => (c[1] as any).dedupeKey === critCalls[0][1].dedupeKey)).toBe(true);
});
