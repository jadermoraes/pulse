/**
 * Route-level tests for /api/roles cap coercion (POST + PUT).
 *
 * A string/garbage monthlyTokenCap must be numerically coerced or rejected (never stored raw),
 * so cap math downstream stays sound. Hermetic in-memory DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { listRoles, getRole } from '$lib/server/identity/roles';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { POST, PUT } from './+server';

function post(body: unknown) {
  return POST({
    request: new Request('http://localhost/api/roles', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }),
    locals: { user: { id: 1 } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}
function put(body: unknown) {
  return PUT({
    request: new Request('http://localhost/api/roles', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }),
    locals: { user: { id: 1 } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});

describe('POST /api/roles — cap coercion', () => {
  it('coerces a numeric-string cap to a number', async () => {
    const res = await post({ name: 'A', allowList: ['discover'], monthlyTokenCap: '5000' });
    const { id } = await res.json();
    expect(getRole(db, id)!.monthlyTokenCap).toBe(5000);
  });

  it('rejects a non-numeric cap with 400', async () => {
    await expect(post({ name: 'B', allowList: [], monthlyTokenCap: 'lots' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('keeps a null cap as null', async () => {
    const res = await post({ name: 'C', allowList: [], monthlyTokenCap: null });
    const { id } = await res.json();
    expect(getRole(db, id)!.monthlyTokenCap).toBeNull();
  });
});

describe('PUT /api/roles — cap coercion', () => {
  let roleId: number;
  beforeEach(async () => {
    const res = await post({ name: 'Member', allowList: ['discover'], monthlyTokenCap: 1000 });
    roleId = (await res.json()).id;
  });

  it('coerces a numeric-string cap to a number', async () => {
    await put({ id: roleId, monthlyTokenCap: '7777' });
    expect(getRole(db, roleId)!.monthlyTokenCap).toBe(7777);
  });

  it('rejects a non-numeric cap with 400', async () => {
    await expect(put({ id: roleId, monthlyTokenCap: 'nope' })).rejects.toMatchObject({ status: 400 });
    // Unchanged.
    expect(getRole(db, roleId)!.monthlyTokenCap).toBe(1000);
  });

  it('leaves the cap untouched when monthlyTokenCap is omitted', async () => {
    await put({ id: roleId, name: 'Member2' });
    expect(getRole(db, roleId)!.monthlyTokenCap).toBe(1000);
    expect(listRoles(db).find((r) => r.id === roleId)!.name).toBe('Member2');
  });
});
