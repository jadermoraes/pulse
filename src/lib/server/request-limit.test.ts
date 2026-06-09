import { it, expect, beforeEach } from 'vitest';
import { rateLimit, __resetRequestLimitState } from './request-limit';

beforeEach(() => __resetRequestLimitState());

it('allows up to max within the window, then blocks with retryAfter', () => {
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) expect(rateLimit('k', 5, 60_000, t + i).ok).toBe(true);
  const r = rateLimit('k', 5, 60_000, t + 5);
  expect(r.ok).toBe(false);
  expect(r.retryAfter).toBeGreaterThan(0);
});

it('the window slides — old hits expire', () => {
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) rateLimit('k', 5, 60_000, t);
  expect(rateLimit('k', 5, 60_000, t).ok).toBe(false);
  expect(rateLimit('k', 5, 60_000, t + 61_000).ok).toBe(true); // window passed
});

it('keys are independent', () => {
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) rateLimit('a', 5, 60_000, t);
  expect(rateLimit('b', 5, 60_000, t).ok).toBe(true);
});
