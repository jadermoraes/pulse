import { describe, it, expect, vi, afterEach } from 'vitest';
import { plex } from './plex';
import type { Connection } from '../connections';

const conn: Connection = { id: 1, type: 'plex', name: 'Plex',
  baseUrl: 'http://plex:32400', secret: 'OWNER-TOK', options: {}, enabled: true };

afterEach(() => vi.restoreAllMocks());

describe('plex integration', () => {
  it('registers minimal config schema (Server URL + X-Plex-Token), no widgets', () => {
    expect(plex.type).toBe('plex');
    expect(plex.label).toBe('Plex');
    expect(plex.configSchema.map((f) => f.key)).toEqual(['baseUrl', 'secret']);
    expect(Object.keys(plex.widgets)).toHaveLength(0);
  });

  it('testConnection GETs /identity with the token and returns the machineIdentifier', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: any) => {
      url = String(u);
      return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'fd6fc902abcdef' } }), { status: 200 });
    }));
    const r = await plex.testConnection(conn);
    expect(r.ok).toBe(true);
    expect(url).toContain('/identity?X-Plex-Token=OWNER-TOK');
    expect(r.message).toContain('fd6fc902');
  });

  it('testConnection fails cleanly on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const r = await plex.testConnection(conn);
    expect(r.ok).toBe(false);
  });
});
