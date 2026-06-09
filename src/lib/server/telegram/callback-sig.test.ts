import { describe, it, expect, beforeEach } from 'vitest';
import { _resetKeyCache } from '../crypto';
import { signCallback, verifyCallback } from './callback-sig';

beforeEach(() => {
  // Force a consistent in-memory key for every test run.
  process.env.PULSE_SECRET_KEY = 'a'.repeat(64);
  _resetKeyCache();
});

describe('signCallback / verifyCallback', () => {
  it('round-trips approve', () => {
    expect(verifyCallback(signCallback('approve', 'p1'))).toEqual({ action: 'approve', pendingId: 'p1' });
  });

  it('round-trips deny', () => {
    expect(verifyCallback(signCallback('deny', 'abc-123'))).toEqual({ action: 'deny', pendingId: 'abc-123' });
  });

  it('round-trips a UUID-shaped pendingId', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(verifyCallback(signCallback('approve', uuid))).toEqual({ action: 'approve', pendingId: uuid });
  });

  it('returns null for a tampered sig', () => {
    const signed = signCallback('approve', 'p1');
    const tampered = signed.slice(0, -4) + 'xxxx';
    expect(verifyCallback(tampered)).toBeNull();
  });

  it('returns null for a tampered action (approve → deny flipped)', () => {
    const signed = signCallback('approve', 'p1');
    const tampered = 'deny' + signed.slice('approve'.length);
    expect(verifyCallback(tampered)).toBeNull();
  });

  it('returns null for a malformed string (missing parts)', () => {
    expect(verifyCallback('approve')).toBeNull();
    expect(verifyCallback('')).toBeNull();
    expect(verifyCallback('approve:')).toBeNull();
  });

  it('returns null for an invalid action', () => {
    // Build a structurally valid string with wrong action name
    expect(verifyCallback('hack:p1:abcdef1234567890')).toBeNull();
  });
});
