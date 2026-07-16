import { describe, it, expect } from 'vitest';
import { usageFromResult } from './usage';

function fakeResult(totals: Record<string, number>, opts: { failConsume?: boolean; failUsage?: boolean } = {}) {
  let consumed = false;
  const totalUsage = opts.failUsage
    ? Promise.reject(new Error('no usage'))
    : Promise.resolve(totals);
  // Pre-attach a handler so an intentionally-rejected fixture that ends up not being awaited
  // (consumeStream throws first) doesn't surface as an unhandled rejection.
  void totalUsage.catch(() => {});
  return {
    result: {
      consumeStream: async () => {
        if (opts.failConsume) throw new Error('stream error');
        consumed = true;
      },
      totalUsage
    },
    wasConsumed: () => consumed
  };
}

describe('usageFromResult', () => {
  it('drains the stream and returns the real token totals', async () => {
    const { result, wasConsumed } = fakeResult({ inputTokens: 193_537, outputTokens: 158, cachedInputTokens: 120_000 });
    const u = await usageFromResult(result);
    expect(wasConsumed()).toBe(true);
    expect(u).toEqual({ input: 193_537, output: 158, cached: 120_000 });
  });

  it('defaults missing fields to zero', async () => {
    const u = await usageFromResult(fakeResult({}).result);
    expect(u).toEqual({ input: 0, output: 0, cached: 0 });
  });

  it('never throws: a failing stream or usage promise yields zeros', async () => {
    const broken = fakeResult({ inputTokens: 5 }, { failConsume: true, failUsage: true }).result;
    await expect(usageFromResult(broken)).resolves.toEqual({ input: 0, output: 0, cached: 0 });
  });
});
