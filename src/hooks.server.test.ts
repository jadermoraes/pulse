import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handle } from './hooks.server';
import { getDb } from '$lib/server/db';
import { createAdmin } from '$lib/server/auth';

// The host guard in hooks.server.ts restricts the deploy-pinned public host to the consumer
// surface + PWA assets. These tests drive `handle` directly with a synthetic RequestEvent.

const PUBLIC_HOST = 'app.example.com';

// A well-formed Stremio addon token. `handle` never inspects it (the dispatcher owns its own
// auth); it is here so the path under test is the real shape a TV requests.
const ADDON_TOKEN = 'a'.repeat(48);

// Marker returned by our fake `resolve` so we can tell "fell through to the app" apart from
// the guard's own Response/redirect/error.
const RESOLVED = new Response('resolved-ok', { status: 200, headers: { 'x-resolved': '1' } });

function makeEvent(opts: { path: string; host: string; cookies?: Record<string, string> }) {
  const headers = new Headers();
  // Simulate the tunnel: the public hostname arrives via x-forwarded-host.
  headers.set('x-forwarded-host', opts.host);
  headers.set('host', opts.host);
  const url = new URL(`https://${opts.host}${opts.path}`);
  const cookies = opts.cookies ?? {};
  return {
    url,
    request: new Request(url, { headers }),
    locals: {} as App.Locals,
    cookies: { get: (name: string) => cookies[name] }
  } as any;
}

// Run `handle`, capturing whichever exit it takes: redirect/error thrown by SvelteKit,
// a Response returned by the guard, or our RESOLVED marker (fell through to the app).
async function run(event: any) {
  try {
    const res = await handle({ event, resolve: async () => RESOLVED } as any);
    return { kind: res === RESOLVED ? ('resolved' as const) : ('response' as const), res };
  } catch (e: any) {
    if (e?.status && e?.location !== undefined) return { kind: 'redirect' as const, status: e.status, location: e.location };
    if (e?.status) return { kind: 'error' as const, status: e.status };
    throw e;
  }
}

beforeEach(() => {
  process.env.PULSE_DISABLE_POLLER = '1';
  // Ensure setup is "done" so the first-run /setup redirect doesn't fire.
  const db = getDb();
  if ((db.prepare('select count(*) c from users').get() as any).c === 0) {
    createAdmin(db, 'admin@example.com', 'pw');
  }
});
afterEach(() => {
  delete process.env.PULSE_PUBLIC_HOST;
  delete process.env.PULSE_PUBLIC_URL;
});

describe('host guard — public host (PULSE_PUBLIC_HOST set)', () => {
  beforeEach(() => {
    process.env.PULSE_PUBLIC_HOST = PUBLIC_HOST;
  });

  it('admin page /settings → plain 404 (not a redirect to /login)', async () => {
    const r = await run(makeEvent({ path: '/settings', host: PUBLIC_HOST }));
    expect(r.kind).toBe('response');
    expect((r as any).res.status).toBe(404);
  });

  it('admin API /api/roles → 404', async () => {
    const r = await run(makeEvent({ path: '/api/roles', host: PUBLIC_HOST }));
    expect(r.kind).toBe('response');
    expect((r as any).res.status).toBe(404);
  });

  it('/login → 404 (admin login invisible)', async () => {
    const r = await run(makeEvent({ path: '/login', host: PUBLIC_HOST }));
    expect(r.kind).toBe('response');
    expect((r as any).res.status).toBe(404);
  });

  it('/api/invites → 404', async () => {
    const r = await run(makeEvent({ path: '/api/invites', host: PUBLIC_HOST }));
    expect(r.kind).toBe('response');
    expect((r as any).res.status).toBe(404);
  });

  it('root / → 307 redirect to /app', async () => {
    const r = await run(makeEvent({ path: '/', host: PUBLIC_HOST }));
    expect(r.kind).toBe('redirect');
    expect((r as any).status).toBe(307);
    expect((r as any).location).toBe('/app');
  });

  it('/app/login → reachable (consumer-public, not 404)', async () => {
    const r = await run(makeEvent({ path: '/app/login', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
  });

  it('/app/reset/<token> → reachable pre-session (consumer-public, not 404)', async () => {
    const r = await run(makeEvent({ path: '/app/reset/abc123', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
  });

  it('/api/app/reset → reachable pre-session (consumer-public, not 401)', async () => {
    const r = await run(makeEvent({ path: '/api/app/reset', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
  });

  it('/api/app/contact → reachable pre-session (consumer-public, not 401)', async () => {
    const r = await run(makeEvent({ path: '/api/app/contact', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
  });

  it('/api/app/telegram/available → reachable pre-session (consumer-public, not 401)', async () => {
    const r = await run(makeEvent({ path: '/api/app/telegram/available', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
  });

  it('/api/app/me → 401 (consumer route, unauth — NOT 404)', async () => {
    const r = await run(makeEvent({ path: '/api/app/me', host: PUBLIC_HOST }));
    expect(r.kind).toBe('error');
    expect((r as any).status).toBe(401);
  });

  it('/manifest.webmanifest → reachable', async () => {
    const r = await run(makeEvent({ path: '/manifest.webmanifest', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
  });

  it('/_app/immutable/... bundle → reachable (critical: app loads)', async () => {
    const r = await run(makeEvent({ path: '/_app/immutable/entry/start.abc123.js', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
  });

  it('/service-worker.js → served WITH Service-Worker-Allowed: /app/ header', async () => {
    const r = await run(makeEvent({ path: '/service-worker.js', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
    expect((r as any).res.headers.get('Service-Worker-Allowed')).toBe('/app/');
  });

  it('/api/image poster proxy → reachable', async () => {
    const r = await run(makeEvent({ path: '/api/image/foo.jpg', host: PUBLIC_HOST }));
    expect(r.kind).toBe('resolved');
  });

  it('CRITICAL: the addon is invisible on the public host', async () => {
    // The addon serves the entire Jellyfin library — catalogue, byte-streaming of every item and
    // the Seerr request action — from a URL with NO auth gate in front of it. The only thing
    // keeping it off the internet is that `/api/_public` is absent from `isPublicHostAllowed`.
    // Adding it there would publish the whole library through the PULSE_PUBLIC_HOST tunnel, and
    // every other test in the suite would stay green.
    const r = await run(makeEvent({ path: `/api/_public/addon/${ADDON_TOKEN}/manifest.json`, host: PUBLIC_HOST }));
    expect(r.kind).toBe('response');
    expect((r as any).res.status).toBe(404);
  });

  it('matches host case-insensitively and ignores port', async () => {
    const r = await run(makeEvent({ path: '/settings', host: 'APP.EXAMPLE.COM:443' }));
    expect(r.kind).toBe('response');
    expect((r as any).res.status).toBe(404);
  });
});

describe('host guard — LAN host (admin reachable, unchanged)', () => {
  beforeEach(() => {
    process.env.PULSE_PUBLIC_HOST = PUBLIC_HOST;
  });

  it('/settings on LAN host without admin session → redirect to /login (today behavior)', async () => {
    const r = await run(makeEvent({ path: '/settings', host: 'dash.home.example.com' }));
    expect(r.kind).toBe('redirect');
    expect((r as any).status).toBe(303);
    expect((r as any).location).toBe('/login');
  });

  it('/api/roles on LAN host without session → 401 (not 404)', async () => {
    const r = await run(makeEvent({ path: '/api/roles', host: 'localhost' }));
    expect(r.kind).toBe('error');
    expect((r as any).status).toBe(401);
  });

  it('/login on LAN host → reachable (public admin page)', async () => {
    const r = await run(makeEvent({ path: '/login', host: 'localhost' }));
    expect(r.kind).toBe('resolved');
  });

  it('CRITICAL: the addon reaches its handler on the LAN with no session', async () => {
    // The mirror image of the public-host test: `/api/_public` must stay exempt from the admin
    // API gate. Stremio sends no cookie at all, so dropping the exemption 401s the addon dead in
    // production for everyone — with the rest of the suite still green.
    const r = await run(makeEvent({ path: `/api/_public/addon/${ADDON_TOKEN}/manifest.json`, host: 'localhost' }));
    expect((r as any).status).not.toBe(401);
    expect(r.kind).toBe('resolved'); // reached the dispatcher, which owns its own auth
  });
});

describe('host guard — inactive when PULSE_PUBLIC_HOST unset', () => {
  it('admin /settings reachable behavior preserved even on what would be the public host', async () => {
    // No PULSE_PUBLIC_HOST → guard inactive → admin gate applies (redirect to /login).
    const r = await run(makeEvent({ path: '/settings', host: PUBLIC_HOST }));
    expect(r.kind).toBe('redirect');
    expect((r as any).location).toBe('/login');
  });

  it('root / behaves as admin (redirect to /login), not 307→/app', async () => {
    const r = await run(makeEvent({ path: '/', host: PUBLIC_HOST }));
    expect(r.kind).toBe('redirect');
    expect((r as any).location).toBe('/login');
  });
});
