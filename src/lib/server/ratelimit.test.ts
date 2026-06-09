import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { loginAllowed, recordLoginFailure, recordLoginSuccess, _resetStore } from './ratelimit';

beforeEach(() => {
  _resetStore();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const IP = '1.2.3.4';

describe('ratelimit', () => {
  it('allows login when no failures recorded', () => {
    expect(loginAllowed(IP).allowed).toBe(true);
  });

  it('allows login for up to 4 failures', () => {
    for (let i = 0; i < 4; i++) {
      recordLoginFailure(IP);
      expect(loginAllowed(IP).allowed).toBe(true);
    }
  });

  it('locks after 5 failures', () => {
    for (let i = 0; i < 5; i++) {
      recordLoginFailure(IP);
    }
    const result = loginAllowed(IP);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBeGreaterThan(0);
    expect(result.retryAfterSec).toBeLessThanOrEqual(15 * 60);
  });

  it('stays locked after 6th failure attempt with retryAfterSec', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(IP);
    recordLoginFailure(IP); // extra attempt while locked
    const result = loginAllowed(IP);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBeDefined();
  });

  it('remains locked mid-window', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(IP);
    vi.advanceTimersByTime(7 * 60 * 1000); // 7 minutes
    const result = loginAllowed(IP);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBeGreaterThan(0);
  });

  it('unlocks after the 15-minute window passes', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(IP);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1); // just past the window
    expect(loginAllowed(IP).allowed).toBe(true);
  });

  it('success clears the counter immediately', () => {
    for (let i = 0; i < 4; i++) recordLoginFailure(IP);
    recordLoginSuccess(IP);
    expect(loginAllowed(IP).allowed).toBe(true);
  });

  it('success after lock clears state', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(IP);
    expect(loginAllowed(IP).allowed).toBe(false);
    recordLoginSuccess(IP);
    expect(loginAllowed(IP).allowed).toBe(true);
  });

  it('does not affect a different IP', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(IP);
    expect(loginAllowed('9.9.9.9').allowed).toBe(true);
  });

  it('counter resets after window rolls over (no lock)', () => {
    for (let i = 0; i < 3; i++) recordLoginFailure(IP);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    // Now record a new failure — should start fresh
    recordLoginFailure(IP);
    expect(loginAllowed(IP).allowed).toBe(true); // only 1 failure, not locked
  });
});
