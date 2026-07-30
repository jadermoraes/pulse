import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import * as reqmod from '$lib/server/consumer/requests';
import * as consumers from '$lib/server/identity/consumers';
import { listAccess } from '$lib/server/identity/access-log';
import { POST as requestPOST } from './+server';
import { GET as requestsGET } from '../requests/+server';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); vi.spyOn(dbmod, 'getDb').mockReturnValue(db); });
afterEach(() => vi.restoreAllMocks());
const consumer = { id: 7, roleId: 1, displayName: 'Ana' };

describe('/api/app/request + /api/app/requests', () => {
  it('401 without a consumer', async () => {
    await expect(requestPOST({ locals: { consumer: null }, request: new Request('http://x', { method: 'POST', body: '{}' }) } as any))
      .rejects.toMatchObject({ status: 401 });
  });

  it('creates a request scoped to the session consumer (ignores body consumerId)', async () => {
    vi.spyOn(consumers, 'getConsumer').mockReturnValue({ id: 7, seerrUserId: 42 } as any);
    const spy = vi.spyOn(reqmod, 'createConsumerRequest')
      .mockResolvedValue({ id: 1, consumerId: 7, status: 'pending' } as any);
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ tmdbId: 100, mediaType: 'movie', consumerId: 999 }) });
    const res = await requestPOST({ locals: { consumer }, request: req, getClientAddress: () => '127.0.0.1' } as any);
    expect(spy).toHaveBeenCalledWith(db, { id: 7, seerrUserId: 42 }, { tmdbId: 100, mediaType: 'movie', audio: 'original' });
    expect((await res.json()).consumerId).toBe(7);
  });

  it('forwards audio:"ptbr" to the request creator', async () => {
    vi.spyOn(consumers, 'getConsumer').mockReturnValue({ id: 7, seerrUserId: 42 } as any);
    const spy = vi.spyOn(reqmod, 'createConsumerRequest')
      .mockResolvedValue({ id: 1, consumerId: 7, status: 'pending' } as any);
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ tmdbId: 920, mediaType: 'movie', audio: 'ptbr' }) });
    await requestPOST({ locals: { consumer }, request: req, getClientAddress: () => '127.0.0.1' } as any);
    expect(spy).toHaveBeenCalledWith(db, { id: 7, seerrUserId: 42 }, { tmdbId: 920, mediaType: 'movie', audio: 'ptbr' });
  });

  it('GET lists only the session consumer requests', async () => {
    const spy = vi.spyOn(reqmod, 'listConsumerRequests').mockResolvedValue([]);
    await requestsGET({ locals: { consumer } } as any);
    expect(spy).toHaveBeenCalledWith(db, 7);
  });

  it('logs a request access event with the title', async () => {
    vi.spyOn(consumers, 'getConsumer').mockReturnValue({ id: 7, seerrUserId: 42 } as any);
    vi.spyOn(reqmod, 'createConsumerRequest')
      .mockResolvedValue({ id: 1, consumerId: 7, status: 'pending', title: 'Dune' } as any);
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ tmdbId: 100, mediaType: 'movie' }) });
    await requestPOST({ locals: { consumer }, request: req, getClientAddress: () => '127.0.0.1' } as any);
    const ev = listAccess(db, {});
    expect(ev[0]).toMatchObject({ type: 'request', detail: 'Dune' });
  });
});
