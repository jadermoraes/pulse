import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Connection } from '../connections';
import { ensureJellyfinUser, authenticateJellyfin, setJellyfinPassword } from './jellyfin';

const conn: Connection = {
  id: 1, type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'JFKEY', options: {}, enabled: true
};

afterEach(() => vi.restoreAllMocks());

/** Build a fetch stub from an ordered list of [matcher, response] handlers. */
function stubFetch(handlers: Array<(url: string, init?: RequestInit) => Response | null>) {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    for (const h of handlers) { const r = h(url, init); if (r) return r; }
    return new Response('unmatched', { status: 500 });
  }));
}

describe('ensureJellyfinUser', () => {
  it('creates a new user when none exists, sets policy, returns the id', async () => {
    const created = { Id: 'jf-new', Name: 'ana' };
    stubFetch([
      (u) => u.includes('/Users') && !u.includes('/Users/New') && !u.includes('/Policy')
        ? new Response(JSON.stringify([]), { status: 200 }) : null,        // GET /Users → empty
      (u) => u.includes('/Users/New') ? new Response(JSON.stringify(created), { status: 200 }) : null,
      (u) => u.includes('/Policy') ? new Response(null, { status: 204 }) : null
    ]);
    const id = await ensureJellyfinUser(conn, 'ana', 'pw');
    expect(id).toBe('jf-new');
  });

  it('is idempotent: reuses an existing user by name (no /Users/New call)', async () => {
    const newCall = vi.fn();
    stubFetch([
      (u) => u.includes('/Users') && !u.includes('/Users/New') && !u.includes('/Policy')
        ? new Response(JSON.stringify([{ Id: 'jf-exists', Name: 'ana' }]), { status: 200 }) : null,
      (u) => { if (u.includes('/Users/New')) { newCall(); return new Response('{}', { status: 200 }); } return null; },
      (u) => u.includes('/Policy') ? new Response(null, { status: 204 }) : null
    ]);
    const id = await ensureJellyfinUser(conn, 'ana', 'pw');
    expect(id).toBe('jf-exists');
    expect(newCall).not.toHaveBeenCalled();
  });

  it('throws a precise error when user creation fails', async () => {
    stubFetch([
      (u) => u.includes('/Users') && !u.includes('/Users/New') ? new Response('[]', { status: 200 }) : null,
      (u) => u.includes('/Users/New') ? new Response('boom', { status: 500 }) : null
    ]);
    await expect(ensureJellyfinUser(conn, 'ana', 'pw')).rejects.toThrow(/jellyfin|HTTP 500/i);
  });

  it('posts the FULL merged policy from the create response (not a 3-key partial)', async () => {
    // The server returns a full default UserPolicy on creation; we must preserve all of
    // its fields and only flip EnableAllFolders/IsAdministrator/IsDisabled.
    const serverPolicy = {
      IsAdministrator: false,
      IsDisabled: false,
      EnableAllFolders: false,
      EnableLiveTvAccess: true,
      EnableMediaPlayback: true,
      EnabledFolders: [],
      MaxParentalRating: null,
      BlockedTags: [],
      EnableContentDeletion: false,
      LoginAttemptsBeforeLockout: -1,
      SyncPlayAccess: 'CreateAndJoinGroups'
    };
    const created = { Id: 'jf-new', Name: 'ana', Policy: serverPolicy };
    let policyBody: any = null;
    stubFetch([
      (u) => u.includes('/Users') && !u.includes('/Users/New') && !u.includes('/Policy')
        ? new Response(JSON.stringify([]), { status: 200 }) : null,
      (u) => u.includes('/Users/New') ? new Response(JSON.stringify(created), { status: 200 }) : null,
      (u, init) => {
        if (u.includes('/Policy')) {
          policyBody = JSON.parse(String(init?.body ?? '{}'));
          return new Response(null, { status: 204 });
        }
        return null;
      }
    ]);
    const id = await ensureJellyfinUser(conn, 'ana', 'pw');
    expect(id).toBe('jf-new');
    // Full object: every original field preserved.
    expect(policyBody).toMatchObject({
      EnableLiveTvAccess: true,
      EnableMediaPlayback: true,
      EnabledFolders: [],
      MaxParentalRating: null,
      BlockedTags: [],
      EnableContentDeletion: false,
      LoginAttemptsBeforeLockout: -1,
      SyncPlayAccess: 'CreateAndJoinGroups'
    });
    // Our overrides applied.
    expect(policyBody.EnableAllFolders).toBe(true);
    expect(policyBody.IsAdministrator).toBe(false);
    expect(policyBody.IsDisabled).toBe(false);
    // Not a 3-key partial.
    expect(Object.keys(policyBody).length).toBeGreaterThan(3);
  });

  it('falls back to GET /Users/{id} for the policy when the create response lacks .Policy', async () => {
    const created = { Id: 'jf-new', Name: 'ana' }; // no Policy
    const fetchedPolicy = {
      IsAdministrator: false,
      IsDisabled: false,
      EnableAllFolders: false,
      EnableLiveTvAccess: false,
      EnableRemoteAccess: true,
      AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider'
    };
    let getUserCalled = false;
    let policyBody: any = null;
    stubFetch([
      // GET /Users (list) → empty
      (u, init) => (init?.method ?? 'GET') === 'GET' && u.endsWith('/Users')
        ? new Response(JSON.stringify([]), { status: 200 }) : null,
      (u) => u.includes('/Users/New') ? new Response(JSON.stringify(created), { status: 200 }) : null,
      // GET /Users/jf-new (single user with Policy)
      (u, init) => {
        if ((init?.method ?? 'GET') === 'GET' && u.endsWith('/Users/jf-new')) {
          getUserCalled = true;
          return new Response(JSON.stringify({ Id: 'jf-new', Name: 'ana', Policy: fetchedPolicy }), { status: 200 });
        }
        return null;
      },
      (u, init) => {
        if (u.includes('/Policy')) {
          policyBody = JSON.parse(String(init?.body ?? '{}'));
          return new Response(null, { status: 204 });
        }
        return null;
      }
    ]);
    const id = await ensureJellyfinUser(conn, 'ana', 'pw');
    expect(id).toBe('jf-new');
    expect(getUserCalled).toBe(true);
    expect(policyBody).toMatchObject({
      EnableLiveTvAccess: false,
      EnableRemoteAccess: true,
      AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider'
    });
    expect(policyBody.EnableAllFolders).toBe(true);
    expect(policyBody.IsAdministrator).toBe(false);
    expect(policyBody.IsDisabled).toBe(false);
    expect(Object.keys(policyBody).length).toBeGreaterThan(3);
  });
});

describe('authenticateJellyfin', () => {
  it('returns the user id on valid credentials', async () => {
    stubFetch([
      (u) => u.includes('/Users/AuthenticateByName')
        ? new Response(JSON.stringify({ User: { Id: 'jf-7' } }), { status: 200 }) : null
    ]);
    expect(await authenticateJellyfin(conn, 'ana', 'pw')).toEqual({ id: 'jf-7' });
  });
  it('returns null on a 401', async () => {
    stubFetch([(u) => u.includes('/Users/AuthenticateByName') ? new Response('no', { status: 401 }) : null]);
    expect(await authenticateJellyfin(conn, 'ana', 'bad')).toBeNull();
  });
  it('sends the X-Emby-Authorization header', async () => {
    let seen = '';
    stubFetch([(u, init) => {
      if (u.includes('/Users/AuthenticateByName')) {
        seen = String((init?.headers as any)['X-Emby-Authorization'] ?? '');
        return new Response(JSON.stringify({ User: { Id: 'x' } }), { status: 200 });
      }
      return null;
    }]);
    await authenticateJellyfin(conn, 'ana', 'pw');
    expect(seen).toContain('MediaBrowser');
  });
});

describe('setJellyfinPassword', () => {
  const conn = { id: 1, type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'k', options: {}, enabled: true } as any;

  it('POSTs the reset+set sequence to /Users/{id}/Password', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    }));
    await setJellyfinPassword(conn, 'jf-ana', 'newPass123');
    expect(calls.every((c) => c.url.includes('/Users/jf-ana/Password'))).toBe(true);
    expect(calls.some((c) => c.body.NewPw === 'newPass123')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('throws on a non-OK Jellyfin response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(setJellyfinPassword(conn, 'jf-ana', 'newPass123')).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
