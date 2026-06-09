import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import * as discover from '$lib/server/consumer/discover';
import { GET as discoverGET } from './+server';
import { GET as searchGET } from '../search/+server';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); vi.spyOn(dbmod, 'getDb').mockReturnValue(db); });
afterEach(() => vi.restoreAllMocks());

const consumer = { id: 7, roleId: 1, displayName: 'Ana' };

describe('/api/app/discover + /api/app/search', () => {
  it('401 without a consumer session', async () => {
    await expect(discoverGET({ locals: { consumer: null } } as any)).rejects.toMatchObject({ status: 401 });
  });

  it('returns DiscoverResult for a consumer', async () => {
    vi.spyOn(discover, 'getDiscover').mockResolvedValue({ newOnServer: [], hot: [], continueWatching: [] });
    const res = await discoverGET({ locals: { consumer } } as any);
    expect(await res.json()).toEqual({ newOnServer: [], hot: [], continueWatching: [] });
  });

  it('search passes the q param through', async () => {
    const spy = vi.spyOn(discover, 'searchDiscover').mockResolvedValue([]);
    const url = new URL('http://x/api/app/search?q=dune');
    const res = await searchGET({ locals: { consumer }, url } as any);
    expect(spy).toHaveBeenCalledWith(db, 'dune');
    expect(await res.json()).toEqual([]);
  });
});
