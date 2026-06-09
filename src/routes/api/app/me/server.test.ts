/**
 * Route-level tests for /api/app/me PATCH language whitelist.
 *
 * A consumer may only set a known locale; anything else is rejected and never written.
 * Hermetic in-memory DB; self-scoped via locals.consumer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { createConsumer, getConsumer } from '$lib/server/identity/consumers';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { PATCH } from './+server';

let consumerId: number;
function call(body: unknown) {
  return PATCH({
    request: new Request('http://localhost/api/app/me', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }),
    locals: { consumer: { id: consumerId, roleId: 1, displayName: 'Ana' } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  const roleId = createRole(db, {
    name: 'Member', allowList: ['discover'], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {}
  });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
});

describe('PATCH /api/app/me — language whitelist', () => {
  it('accepts a known locale (pt-BR)', async () => {
    const res = await call({ language: 'pt-BR' });
    expect(res.status ?? 200).toBe(200);
    expect(getConsumer(db, consumerId)!.language).toBe('pt-BR');
  });

  it('rejects an unknown locale and leaves language unchanged', async () => {
    await expect(call({ language: 'fr' })).rejects.toMatchObject({ status: 400 });
    expect(getConsumer(db, consumerId)!.language).toBe('en');
  });

  it('rejects a SQL-ish junk value', async () => {
    await expect(call({ language: "en'; drop table consumer_users;--" }))
      .rejects.toMatchObject({ status: 400 });
    expect(getConsumer(db, consumerId)!.language).toBe('en');
  });
});
