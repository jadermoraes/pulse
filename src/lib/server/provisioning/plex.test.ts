import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPlexPin, pollPlexPin, sharePlexLibraries } from './plex';

afterEach(() => vi.restoreAllMocks());
function stubFetch(handlers: Array<(url: string, init?: RequestInit) => Response | null>) {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    for (const h of handlers) { const r = h(url, init); if (r) return r; }
    return new Response('unmatched', { status: 500 });
  }));
}

describe('plex linking', () => {
  it('createPlexPin returns id + code + an auth URL', async () => {
    stubFetch([(u, init) => u.includes('/api/v2/pins') && init?.method === 'POST'
      ? new Response(JSON.stringify({ id: 123, code: 'ABCD' }), { status: 201 }) : null]);
    const pin = await createPlexPin('client-1');
    expect(pin.id).toBe(123);
    expect(pin.code).toBe('ABCD');
    expect(pin.authUrl).toContain('code=ABCD');
    expect(pin.authUrl).toContain('clientID=client-1');
  });

  it('pollPlexPin returns the authToken once authorized, null while pending', async () => {
    stubFetch([(u) => /\/api\/v2\/pins\/123/.test(u)
      ? new Response(JSON.stringify({ id: 123, authToken: 'plex-tok' }), { status: 200 }) : null]);
    expect(await pollPlexPin(123, 'client-1')).toBe('plex-tok');

    stubFetch([(u) => /\/api\/v2\/pins\/123/.test(u)
      ? new Response(JSON.stringify({ id: 123, authToken: null }), { status: 200 }) : null]);
    expect(await pollPlexPin(123, 'client-1')).toBeNull();
  });

  it('sharePlexLibraries posts a v1 shared_servers invite (email-based, owner token)', async () => {
    let body: any = null;
    let url = '';
    let token = '';
    stubFetch([(u, init) => /\/api\/servers\/machine-1\/shared_servers$/.test(u) && init?.method === 'POST'
      ? (url = u, token = (init?.headers as any)?.['X-Plex-Token'],
         body = JSON.parse(String(init?.body)), new Response('{}', { status: 200 })) : null]);
    await sharePlexLibraries('owner-tok', 'machine-1', [1, 2], 'invitee@x.com');
    // Legacy v1 endpoint on /api/servers/{machineId}, authed with the owner token.
    expect(url).toContain('/api/servers/machine-1/shared_servers');
    expect(token).toBe('owner-tok');
    // python-plexapi inviteFriend payload shape.
    expect(body.server_id).toBe('machine-1');
    expect(body.shared_server.invited_email).toBe('invitee@x.com');
    expect(body.shared_server.library_section_ids).toEqual([1, 2]);
    expect(body.sharing_settings).toEqual({});
  });
});
