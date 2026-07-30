import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import * as http from '../http';
import * as widgets from '../../widgets';
import { createConsumerRequest, listConsumerRequests, syncConsumerRequestStatus } from './requests';
import type { ConsumerUser } from '../identity/types';

let db: DB; let seerrId: number;
const consumer = (over: Partial<ConsumerUser> = {}): ConsumerUser => ({
  id: 7, roleId: 1, displayName: 'Ana', jellyfinUserId: 'jf', jellyfinUsername: null,
  seerrUserId: 42, plexAccountId: null, language: 'en', capOverride: null, allowOverride: null,
  status: 'active', createdAt: 0, ...over
});
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  seerrId = createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
  // Insert a role + consumer_users row so FK constraints are satisfied
  const roleId = db.prepare(
    `insert into roles (name, allow_list, monthly_token_cap, auto_approve, seerr_quota, is_admin, editable, created_at) values (?,?,?,?,?,?,?,?)`
  ).run('Viewer', '[]', null, 0, '{}', 0, 1, Date.now()).lastInsertRowid;
  db.prepare(
    `insert into consumer_users (id, role_id, display_name, language, status, created_at) values (7,?,?,?,?,?)`
  ).run(roleId, 'Ana', 'en', 'active', Date.now());
});
afterEach(() => vi.restoreAllMocks());

describe('consumer requests', () => {
  it('POSTs to seerr with the viewer userId, inserts a mapped row', async () => {
    const send = vi.spyOn(http, 'sendJsonWithKey').mockResolvedValue({ id: 555 } as any);
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({ title: 'Dune' } as any);
    const r = await createConsumerRequest(db, consumer(), { tmdbId: 100, mediaType: 'movie' });
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/request'), 'POST', 'K',
      { mediaType: 'movie', mediaId: 100, userId: 42 }
    );
    expect(r.seerrRequestId).toBe(555);
    expect(r.tmdbId).toBe(100);
    expect(r.title).toBe('Dune');
    expect(r.status).toBe('pending');
    expect(r.consumerId).toBe(7);
  });

  it('resolves audio:"ptbr" to the PT-BR quality profile and sends profileId + serverId', async () => {
    const send = vi.spyOn(http, 'sendJsonWithKey').mockResolvedValue({ id: 777 } as any);
    // getJsonWithKey serves the seerr service endpoints (profile discovery) + the detail title.
    vi.spyOn(http, 'getJsonWithKey').mockImplementation(async (url: string) => {
      if (url.includes('/service/radarr/')) {
        return { profiles: [{ id: 7, name: 'Standard 1080p' }, { id: 8, name: 'Standard 1080p (PT-BR)' }] } as any;
      }
      if (url.includes('/service/radarr')) return [{ id: 0, isDefault: true }] as any;
      return { title: 'Cars' } as any;
    });
    await createConsumerRequest(db, consumer(), { tmdbId: 920, mediaType: 'movie', audio: 'ptbr' });
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/request'), 'POST', 'K',
      { mediaType: 'movie', mediaId: 920, userId: 42, profileId: 8, serverId: 0 }
    );
  });

  it('does NOT add a profile for audio:"original" (uses seerr default)', async () => {
    const send = vi.spyOn(http, 'sendJsonWithKey').mockResolvedValue({ id: 1 } as any);
    const get = vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({ title: 'Cars' } as any);
    await createConsumerRequest(db, consumer(), { tmdbId: 920, mediaType: 'movie', audio: 'original' });
    expect(send).toHaveBeenCalledWith(
      expect.any(String), 'POST', 'K',
      { mediaType: 'movie', mediaId: 920, userId: 42 }
    );
    // no /service/* discovery calls when audio isn't ptbr
    expect(get.mock.calls.every(([u]) => !String(u).includes('/service/'))).toBe(true);
  });

  it('adds seasons:"all" for tv requests', async () => {
    const send = vi.spyOn(http, 'sendJsonWithKey').mockResolvedValue({ id: 9 } as any);
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({ name: 'Severance' } as any);
    await createConsumerRequest(db, consumer(), { tmdbId: 200, mediaType: 'tv' });
    expect(send).toHaveBeenCalledWith(
      expect.any(String), 'POST', 'K',
      { mediaType: 'tv', mediaId: 200, userId: 42, seasons: 'all' }
    );
  });

  it('lists requests with live status mapped from the seerr widget label', async () => {
    vi.spyOn(http, 'sendJsonWithKey').mockResolvedValue({ id: 555 } as any);
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({ title: 'Dune' } as any);
    await createConsumerRequest(db, consumer(), { tmdbId: 100, mediaType: 'movie' });
    vi.spyOn(widgets, 'resolveWidget').mockResolvedValue({
      ok: true, data: [{ id: 555, title: 'Dune', status: 'Available' }]
    } as any);
    const list = await listConsumerRequests(db, 7);
    expect(list[0].status).toBe('available');
  });

  it('syncConsumerRequestStatus flips a tracked row to available', async () => {
    vi.spyOn(http, 'sendJsonWithKey').mockResolvedValue({ id: 555 } as any);
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({ title: 'Dune' } as any);
    await createConsumerRequest(db, consumer(), { tmdbId: 100, mediaType: 'movie' });
    vi.spyOn(widgets, 'resolveWidget').mockResolvedValue({
      ok: true, data: [{ id: 555, title: 'Dune', status: 'Available' }]
    } as any);
    await syncConsumerRequestStatus(db);
    const row = db.prepare('select status from consumer_requests where seerr_request_id=555').get() as any;
    expect(row.status).toBe('available');
  });
});
