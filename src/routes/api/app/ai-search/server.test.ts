import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { createConsumer } from '$lib/server/identity/consumers';
import { addUsage } from '$lib/server/identity/usage';
import * as provider from '$lib/server/agent/provider';
import * as aiSearch from '$lib/server/consumer/ai-search';
import { POST } from './+server';

let db: DB;
let roleId: number;
let consumerId: number;

beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  vi.spyOn(dbmod, 'getDb').mockReturnValue(db);
  roleId = createRole(db, { name: 'V', allowList: ['discover'], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
});
afterEach(() => vi.restoreAllMocks());

function req(body: unknown, consumer: any = { id: consumerId, roleId, displayName: 'Ana' }) {
  return { request: { json: async () => body }, locals: { consumer } } as any;
}

describe('POST /api/app/ai-search', () => {
  it('401 without a consumer session', async () => {
    await expect(POST(req({ q: 'x' }, null))).rejects.toMatchObject({ status: 401 });
  });

  it('blank query returns empty items without a model call', async () => {
    const model = vi.spyOn(provider, 'getConsumerModel');
    const res = await POST(req({ q: '   ' }));
    expect(await res.json()).toEqual({ items: [] });
    expect(model).not.toHaveBeenCalled();
  });

  it('cap-gates BEFORE any model call → { blocked: cap }', async () => {
    addUsage(db, consumerId, 2000); // over the 1000 cap
    const model = vi.spyOn(provider, 'getConsumerModel');
    const vibe = vi.spyOn(aiSearch, 'aiVibeSearch');
    const res = await POST(req({ q: 'cozy sci-fi' }));
    expect(await res.json()).toEqual({ blocked: 'cap' });
    expect(model).not.toHaveBeenCalled();
    expect(vibe).not.toHaveBeenCalled();
  });

  it('runs the vibe search, returns items, and meters the tokens', async () => {
    vi.spyOn(provider, 'getConsumerModel').mockReturnValue({} as any);
    const items = [{ source: 'seerr', title: 'Inception', mediaType: 'movie', onServer: false, tmdbId: 27205 }];
    vi.spyOn(aiSearch, 'aiVibeSearch').mockResolvedValue({ items: items as any, tokens: 42 });
    const res = await POST(req({ q: 'movies like Inception' }));
    expect(await res.json()).toEqual({ items });
    const used = db.prepare('select tokens_used from usage_counters where consumer_id=?').get(consumerId) as any;
    expect(used.tokens_used).toBe(42);
  });
});
