import { describe, it, expect, vi, afterEach } from 'vitest';
import { tautulli } from './tautulli';
import type { Connection } from '../connections';

const conn: Connection = { id: 1, type: 'tautulli', name: 'Tautulli',
  baseUrl: 'http://tautulli:8181', secret: 'TKEY', options: {}, enabled: true };

afterEach(() => vi.restoreAllMocks());

function mockByCmd(map: Record<string, any>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cmd = new URL(url).searchParams.get('cmd') ?? '';
    const body = map[cmd];
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404,
      json: async () => ({ response: { result: 'success', data: body } }) } as Response;
  }));
}

describe('tautulli integration', () => {
  it('testConnection ok and keeps the apikey in the query (server-side only)', async () => {
    mockByCmd({ get_server_info: { pms_name: 'Plex' } });
    const r = await tautulli.testConnection(conn);
    expect(r.ok).toBe(true);
    // key travels in the query (Tautulli has no header auth) — never serialized to the client.
    expect((fetch as any).mock.calls[0][0]).toContain('apikey=TKEY');
  });

  it('testConnection fails on non-200', async () => {
    mockByCmd({});
    expect((await tautulli.testConnection(conn)).ok).toBe(false);
  });

  it('activity maps current streams + count', async () => {
    mockByCmd({ get_activity: {
      stream_count: '2',
      sessions: [
        { friendly_name: 'Ada', full_title: 'Apex', progress_percent: '40', state: 'playing' },
        { friendly_name: 'Leo', full_title: 'Rocky', progress_percent: '88', state: 'paused' }
      ]
    } });
    const r = await tautulli.widgets.activity(conn);
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.count).toBe(2);
    expect(d.sessions[0]).toMatchObject({ user: 'Ada', title: 'Apex', progress: 40, state: 'playing' });
  });

  it('history maps rows + total count', async () => {
    mockByCmd({ get_history: {
      recordsFiltered: 57,
      data: [{ friendly_name: 'Ada', full_title: 'Apex', watched_status: 1 }]
    } });
    const r = await tautulli.widgets.history(conn);
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.total).toBe(57);
    expect(d.rows[0]).toMatchObject({ user: 'Ada', title: 'Apex' });
  });

  it('activity returns ok:false on upstream error', async () => {
    mockByCmd({});
    expect((await tautulli.widgets.activity(conn)).ok).toBe(false);
  });
});
