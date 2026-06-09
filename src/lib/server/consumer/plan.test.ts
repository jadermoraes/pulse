import { describe, it, expect } from 'vitest';
import { TOKEN_PLANS } from './types';
import { planToCap, capToPlan, chatsLeft } from './plan';

describe('token plans', () => {
  it('maps named plans to caps', () => {
    expect(planToCap('Light')).toBe(250_000);
    expect(planToCap('Regular')).toBe(1_000_000);
    expect(planToCap('Power')).toBe(5_000_000);
    expect(planToCap('Unlimited')).toBeNull();
    expect(planToCap('Custom', 42_000)).toBe(42_000);
  });

  it('maps a cap back to its plan name (Custom for non-matching)', () => {
    expect(capToPlan(1_000_000)).toBe('Regular');
    expect(capToPlan(null)).toBe('Unlimited');
    expect(capToPlan(333_333)).toBe('Custom');
  });

  it('computes chats left (floor of remaining / AVG_TOKENS_PER_CHAT)', () => {
    expect(chatsLeft(1_000_000, 0)).toBe(Math.floor(1_000_000 / 12_000));
    expect(chatsLeft(1_000_000, 994_000)).toBe(0);
    expect(chatsLeft(null, 9_999_999)).toBe(Infinity);
  });

  it('TOKEN_PLANS exposes the four named tiers', () => {
    expect(Object.keys(TOKEN_PLANS)).toEqual(['Light', 'Regular', 'Power', 'Unlimited']);
  });
});
