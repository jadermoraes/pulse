import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import * as discover from '$lib/server/consumer/discover';
import { GET } from './+server';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); vi.spyOn(dbmod, 'getDb').mockReturnValue(db); });
afterEach(() => vi.restoreAllMocks());

const consumer = { id: 7, roleId: 1, displayName: 'Ana' };
const url = (qs: string) => new URL(`http://x/api/app/detail${qs}`);

describe('/api/app/detail', () => {
  it('401 without a consumer session', async () => {
    await expect(
      GET({ locals: { consumer: null }, url: url('?tmdbId=1&mediaType=movie') } as any)
    ).rejects.toMatchObject({ status: 401 });
  });

  it('400 when tmdbId is missing or invalid', async () => {
    await expect(
      GET({ locals: { consumer }, url: url('?mediaType=movie') } as any)
    ).rejects.toMatchObject({ status: 400 });
  });

  it('returns rich detail for a consumer', async () => {
    const detail = {
      title: 'Dune', year: 2021, overview: 'Sand.', genres: ['Sci-Fi'],
      rating: 8.0, runtimeMin: 155, poster: 'p', backdrop: 'b',
      available: true, status: 'Available'
    };
    const spy = vi.spyOn(discover, 'getDetail').mockResolvedValue(detail);
    const res = await GET({ locals: { consumer }, url: url('?tmdbId=100&mediaType=movie') } as any);
    // No consumer row in this in-memory DB ⇒ language defaults to 'en'.
    expect(spy).toHaveBeenCalledWith(db, 100, 'movie', 'en');
    expect(await res.json()).toEqual(detail);
  });

  it('passes the consumer\'s language to getDetail (pt-BR)', async () => {
    // Seed a consumer row with language pt-BR so the endpoint threads it through.
    const roleId = db.prepare(
      `insert into roles (name, allow_list, monthly_token_cap, auto_approve, seerr_quota, is_admin, editable, created_at) values (?,?,?,?,?,?,?,?)`
    ).run('Viewer', '[]', null, 0, '{}', 0, 1, Date.now()).lastInsertRowid;
    db.prepare(
      `insert into consumer_users (id, role_id, display_name, language, status, created_at) values (7,?,?,?,?,?)`
    ).run(roleId, 'Ana', 'pt-BR', 'active', Date.now());
    const spy = vi.spyOn(discover, 'getDetail').mockResolvedValue({
      title: 'Duna', year: 2021, overview: 'Areia.', genres: ['Ficção científica'],
      available: false, status: 'Not on server'
    } as any);
    await GET({ locals: { consumer }, url: url('?tmdbId=100&mediaType=movie') } as any);
    expect(spy).toHaveBeenCalledWith(db, 100, 'movie', 'pt-BR');
  });

  it('404 when no media source is configured', async () => {
    vi.spyOn(discover, 'getDetail').mockResolvedValue(null);
    await expect(
      GET({ locals: { consumer }, url: url('?tmdbId=1&mediaType=tv') } as any)
    ).rejects.toMatchObject({ status: 404 });
  });
});
