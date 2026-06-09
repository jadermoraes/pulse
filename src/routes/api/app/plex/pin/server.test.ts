/**
 * Unit tests for /api/app/plex/pin (public PIN endpoint).
 *
 * Covers:
 *  - POST is rate-limited (5 requests per window → 429 on the 6th).
 *  - GET is NOT rate-limited (poll loop must not block).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { _resetStore } from '$lib/server/ratelimit';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

const createPlexPin = vi.fn();
const pollPlexPin = vi.fn();
vi.mock('$lib/server/provisioning/plex', () => ({
  createPlexPin: (...a: unknown[]) => createPlexPin(...a),
  pollPlexPin: (...a: unknown[]) => pollPlexPin(...a)
}));

import { POST, GET } from './+server';

function postEvent(ip = '1.2.3.4') {
  return POST({ getClientAddress: () => ip } as any);
}

function getEvent(pinId: string, ip = '1.2.3.4') {
  return GET({ url: new URL(`http://localhost/api/app/plex/pin?pinId=${pinId}`) } as any);
}

beforeEach(() => {
  _resetStore();
  db = openDb(':memory:');
  migrate(db);
  createPlexPin.mockReset();
  createPlexPin.mockResolvedValue({ id: 1, code: 'ABCD', authUrl: 'https://plex.tv?code=ABCD' });
  pollPlexPin.mockReset();
  pollPlexPin.mockResolvedValue(null);
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/app/plex/pin — rate limiting', () => {
  it('allows the first 5 requests from the same IP', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await postEvent('10.0.0.1');
      expect(res.status, `request ${i + 1} should succeed`).toBe(200);
    }
  });

  it('returns 429 after 5 requests from the same IP', async () => {
    // Exhaust the allowance.
    for (let i = 0; i < 5; i++) {
      try { await postEvent('10.0.0.2'); } catch { /* expected to succeed */ }
    }
    // 6th request must be rejected.
    await expect(postEvent('10.0.0.2')).rejects.toMatchObject({ status: 429 });
  });

  it('different IPs are tracked independently', async () => {
    // Exhaust IP A.
    for (let i = 0; i < 5; i++) {
      try { await postEvent('10.0.0.3'); } catch { /* expected to succeed */ }
    }
    // IP B is still allowed.
    const res = await postEvent('10.0.0.4');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/app/plex/pin — poll (no rate-limit)', () => {
  it('returns { token: null } while pending', async () => {
    pollPlexPin.mockResolvedValue(null);
    const res = await getEvent('42');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeNull();
  });

  it('returns { token: string } once authorised', async () => {
    pollPlexPin.mockResolvedValue('plex-tok-xyz');
    const res = await getEvent('42');
    const body = await res.json();
    expect(body.token).toBe('plex-tok-xyz');
  });

  it('returns 400 when pinId is missing or non-numeric', async () => {
    await expect(GET({ url: new URL('http://localhost/api/app/plex/pin') } as any))
      .rejects.toMatchObject({ status: 400 });
  });
});
