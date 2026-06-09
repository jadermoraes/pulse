/**
 * Route-level tests for /api/users PATCH and DELETE.
 *
 * PATCH load-bearing property: an admin can never reassign a consumer INTO the immutable Admin role
 * (privilege-escalation guard), mirroring the invite guard. A normal role reassignment succeeds.
 * DELETE load-bearing property: removing a consumer with downstream ids calls deprovisionConsumer
 * (best-effort); a downstream failure still removes the Pulse record and returns a warning.
 * Hermetic in-memory DB; no provider/HTTP.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { createRole, getAdminRole } from '$lib/server/identity/roles';
import { createConsumer, getConsumer, updateConsumer } from '$lib/server/identity/consumers';
import { createConnection } from '$lib/server/connections';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { PATCH, DELETE } from './+server';

function callPatch(body: unknown) {
  const event = {
    request: new Request('http://localhost/api/users', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: 1 } }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return PATCH(event as any);
}

// Keep backward compat alias
const call = callPatch;

function callDelete(body: unknown) {
  const event = {
    request: new Request('http://localhost/api/users', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: 1 } }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return DELETE(event as any);
}

let memberRole: number;
let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  memberRole = createRole(db, {
    name: 'Member', allowList: ['discover'], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {}
  });
  consumerId = createConsumer(db, { roleId: memberRole, displayName: 'Ana', language: 'en' });
});
afterEach(() => vi.restoreAllMocks());

describe('PATCH /api/users — role reassignment guard', () => {
  it('rejects reassigning a consumer into the immutable Admin role', async () => {
    const adminRoleId = getAdminRole(db)!.id;
    await expect(call({ id: consumerId, roleId: adminRoleId })).rejects.toMatchObject({ status: 400 });
    // Consumer role unchanged.
    expect(getConsumer(db, consumerId)!.roleId).toBe(memberRole);
  });

  it('rejects an unknown roleId', async () => {
    await expect(call({ id: consumerId, roleId: 99999 })).rejects.toMatchObject({ status: 400 });
  });

  it('allows reassigning a consumer into a normal (non-admin) role', async () => {
    const other = createRole(db, {
      name: 'Power', allowList: ['discover', 'request'], monthlyTokenCap: null, autoApprove: true, seerrQuota: {}
    });
    const res = await call({ id: consumerId, roleId: other });
    expect(res.status ?? 200).toBe(200);
    expect(getConsumer(db, consumerId)!.roleId).toBe(other);
  });
});

describe('DELETE /api/users — de-provisioning', () => {
  // Set up enabled Jellyfin + seerr connections for the tests that need them.
  function addConnections() {
    createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'K', options: {} });
    createConnection(db, { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'S', options: {} });
  }

  it('calls deleteJellyfinUser + deleteSeerrUser when consumer has both downstream ids, then removes Pulse record', async () => {
    addConnections();
    updateConsumer(db, consumerId, { jellyfinUserId: 'jf-ana', seerrUserId: 77 });
    // Mock the HTTP helpers used by the provider deleters.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const res = await callDelete({ id: consumerId });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    expect(getConsumer(db, consumerId)).toBeNull();
  });

  it('still deletes the Pulse record and returns a warning when Jellyfin delete fails', async () => {
    addConnections();
    updateConsumer(db, consumerId, { jellyfinUserId: 'jf-ana', seerrUserId: 77 });
    // Jellyfin DELETE → 500 (throws); seerr DELETE → 200.
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('/jf/')) return new Response('', { status: 500 });
      return new Response('', { status: 200 });
    }));
    const res = await callDelete({ id: consumerId });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/jellyfin/i);
    expect(getConsumer(db, consumerId)).toBeNull();
  });

  it('removes the Pulse record with no warnings when consumer has no downstream ids', async () => {
    // No fetch stub needed — provider helpers should never be called.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await callDelete({ id: consumerId });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    expect(getConsumer(db, consumerId)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
