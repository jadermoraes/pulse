/**
 * Unit tests for the consumer onboarding (`/api/app/join`) endpoint.
 *
 * Hermetic: the DB is an in-memory better-sqlite3 instance (no /data file), the provider
 * provisioning + Jellyfin federated login are mocked at the module boundary. No real
 * Jellyfin/seerr/LLM is touched.
 *
 * The load-bearing assertion is the invite-ordering contract: the invite is only burned
 * AFTER provisioning succeeds, so a failed onboard leaves the invite reusable for a retry.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { mintInvite, getInvite, acceptInvite } from '$lib/server/identity/invites';
import { listConsumers } from '$lib/server/identity/consumers';
import { _resetStore } from '$lib/server/ratelimit';

// --- Module mocks (provider boundary + DB) ---------------------------------------------
let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

const provisionConsumer = vi.fn();
vi.mock('$lib/server/provisioning/provision', () => ({
  provisionConsumer: (...a: unknown[]) => provisionConsumer(...a)
}));

const loginConsumer = vi.fn();
vi.mock('$lib/server/identity/consumer-auth', () => ({
  loginConsumer: (...a: unknown[]) => loginConsumer(...a)
}));

const deleteJellyfinUser = vi.fn();
const jellyfinUsernameTaken = vi.fn();
vi.mock('$lib/server/provisioning/jellyfin', () => ({
  deleteJellyfinUser: (...a: unknown[]) => deleteJellyfinUser(...a),
  jellyfinUsernameTaken: (...a: unknown[]) => jellyfinUsernameTaken(...a)
}));

const deleteSeerrUser = vi.fn();
vi.mock('$lib/server/provisioning/seerr', () => ({
  deleteSeerrUser: (...a: unknown[]) => deleteSeerrUser(...a)
}));

// Cleanup looks up the live connections to call the provider deletes against.
vi.mock('$lib/server/connections', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/connections');
  return {
    ...real,
    listConnections: () => [
      { id: 1, type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'k', options: {}, enabled: true },
      { id: 2, type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'k', options: {}, enabled: true }
    ]
  };
});

// Import AFTER the mocks are registered.
import { POST } from './+server';

function call(body: unknown) {
  const event = {
    request: new Request('http://localhost/api/app/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    cookies: { set: vi.fn() },
    getClientAddress: () => '203.0.113.7'
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(event as any);
}

let roleId: number;
let token: string;
beforeEach(() => {
  _resetStore();
  db = openDb(':memory:');
  migrate(db);
  roleId = createRole(db, {
    name: 'Member', allowList: ['discover', 'request', 'status'],
    monthlyTokenCap: 50000, autoApprove: false, seerrQuota: { movie: 5 }
  });
  token = mintInvite(db, roleId, 1).token;
  provisionConsumer.mockReset();
  loginConsumer.mockReset();
  loginConsumer.mockResolvedValue('sid-123');
  deleteJellyfinUser.mockReset();
  deleteJellyfinUser.mockResolvedValue(undefined);
  deleteSeerrUser.mockReset();
  deleteSeerrUser.mockResolvedValue(undefined);
  jellyfinUsernameTaken.mockReset();
  jellyfinUsernameTaken.mockResolvedValue(false); // default: username free
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/app/join — happy path', () => {
  it('provisions, accepts the invite, and issues a consumer session', async () => {
    provisionConsumer.mockResolvedValue({ jellyfinUserId: 'jf-ana', seerrUserId: 42 });
    const res = await call({ token, displayName: 'Ana', username: 'ana', password: 'password123', language: 'pt-BR' });
    expect(res.status).toBe(201);
    // Invite is now burned (single-use).
    expect(getInvite(db, token)!.acceptedAt).not.toBeNull();
    // Exactly one consumer row exists.
    expect(listConsumers(db)).toHaveLength(1);
    // Session was issued.
    expect(loginConsumer).toHaveBeenCalledWith(expect.anything(), 'ana', 'password123', expect.anything());
  });
});

describe('POST /api/app/join — provisioning failure is retryable (invite NOT burned)', () => {
  it('rolls back the consumer AND leaves the invite unaccepted/reusable when provisioning fails', async () => {
    provisionConsumer.mockRejectedValue(new Error('seerr down'));
    await expect(call({ token, displayName: 'Ana', username: 'ana', password: 'password123' }))
      .rejects.toMatchObject({ status: 502 });

    // Consumer row rolled back — no orphan record.
    expect(listConsumers(db)).toHaveLength(0);
    // Invite remains reusable: never marked accepted, still valid.
    const inv = getInvite(db, token)!;
    expect(inv.acceptedAt).toBeNull();
    expect(inv.acceptedConsumerId).toBeNull();
    expect(inv.expiresAt).toBeGreaterThan(Date.now());

    // The very same invite can be retried and now succeeds.
    provisionConsumer.mockResolvedValue({ jellyfinUserId: 'jf-ana', seerrUserId: 42 });
    const retry = await call({ token, displayName: 'Ana', username: 'ana', password: 'password123' });
    expect(retry.status).toBe(201);
    expect(getInvite(db, token)!.acceptedAt).not.toBeNull();
    expect(listConsumers(db)).toHaveLength(1);
  });

  it('does not issue a session when provisioning fails', async () => {
    provisionConsumer.mockRejectedValue(new Error('jellyfin down'));
    await expect(call({ token, displayName: 'Bo', username: 'bob', password: 'password123' }))
      .rejects.toMatchObject({ status: 502 });
    expect(loginConsumer).not.toHaveBeenCalled();
  });

  it('does NOT de-provision downstream when provisioning itself fails (no ids created)', async () => {
    provisionConsumer.mockRejectedValue(new Error('seerr down'));
    await expect(call({ token, displayName: 'Bo', username: 'bob', password: 'password123' }))
      .rejects.toMatchObject({ status: 502 });
    expect(deleteJellyfinUser).not.toHaveBeenCalled();
    expect(deleteSeerrUser).not.toHaveBeenCalled();
  });
});

describe('POST /api/app/join — race-loser de-provisions the just-created downstream accounts', () => {
  // Simulate the concurrent race: the invite read at the top of the handler is still valid, but by
  // the time provisioning finishes a concurrent join has burned it, so acceptInvite throws. We model
  // that by burning the invite as a side effect of the (mocked) provision call.
  it('tears down Jellyfin+seerr ids when acceptInvite throws (invite already burned by a concurrent join)', async () => {
    provisionConsumer.mockImplementationOnce(async () => {
      acceptInvite(db, token, 9999); // a concurrent winner burns the invite mid-provision
      return { jellyfinUserId: 'jf-lose', seerrUserId: 22 };
    });
    await expect(call({ token, displayName: 'Lose', username: 'lose', password: 'password123' }))
      .rejects.toMatchObject({ status: 502 });

    // The loser's freshly-provisioned downstream accounts are cleaned up (no orphans).
    expect(deleteJellyfinUser).toHaveBeenCalledWith(expect.anything(), 'jf-lose');
    expect(deleteSeerrUser).toHaveBeenCalledWith(expect.anything(), 22);
    // The loser's half-created Pulse consumer row is unwound.
    expect(listConsumers(db)).toHaveLength(0);
  });

  it('surfaces the original 502 even if downstream cleanup itself fails', async () => {
    provisionConsumer.mockImplementationOnce(async () => {
      acceptInvite(db, token, 9999);
      return { jellyfinUserId: 'jf-lose', seerrUserId: 22 };
    });
    deleteJellyfinUser.mockRejectedValueOnce(new Error('jellyfin delete 500'));
    await expect(call({ token, displayName: 'Lose', username: 'lose', password: 'password123' }))
      .rejects.toMatchObject({ status: 502 });
    expect(listConsumers(db)).toHaveLength(0);
  });
});

describe('POST /api/app/join — validation + invite guards', () => {
  it('rejects an unknown/expired invite without provisioning', async () => {
    await expect(call({ token: 'nope', displayName: 'X', username: 'xyz', password: 'password123' }))
      .rejects.toMatchObject({ status: 400 });
    expect(provisionConsumer).not.toHaveBeenCalled();
  });

  it('rejects a short password', async () => {
    await expect(call({ token, displayName: 'X', username: 'xyz', password: 'short' }))
      .rejects.toMatchObject({ status: 400 });
    expect(provisionConsumer).not.toHaveBeenCalled();
  });

  it('rejects an invalid username (spaces) without provisioning', async () => {
    await expect(call({ token, displayName: 'X', username: 'has space', password: 'password123' }))
      .rejects.toMatchObject({ status: 400 });
    expect(provisionConsumer).not.toHaveBeenCalled();
  });

  it('rejects a username already taken on Jellyfin with 409 (no provisioning)', async () => {
    jellyfinUsernameTaken.mockResolvedValue(true);
    await expect(call({ token, displayName: 'Ana', username: 'ana', password: 'password123' }))
      .rejects.toMatchObject({ status: 409 });
    expect(provisionConsumer).not.toHaveBeenCalled();
  });

  it('still onboards when the Jellyfin availability check itself errors (does not block)', async () => {
    jellyfinUsernameTaken.mockRejectedValue(new Error('jellyfin unreachable'));
    provisionConsumer.mockResolvedValue({ jellyfinUserId: 'jf-ana', seerrUserId: 7 });
    const res = await call({ token, displayName: 'Ana', username: 'ana', password: 'password123' });
    expect(res.status).toBe(201);
  });

  it('rejects an already-accepted invite', async () => {
    provisionConsumer.mockResolvedValue({ jellyfinUserId: 'jf-1', seerrUserId: 1 });
    await call({ token, displayName: 'Ana', username: 'ana', password: 'password123' });
    await expect(call({ token, displayName: 'Ana2', username: 'ana2', password: 'password123' }))
      .rejects.toMatchObject({ status: 400 });
  });
});
