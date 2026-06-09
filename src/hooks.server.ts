import type { Handle } from '@sveltejs/kit';
import { redirect, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { isSetup, validateSession } from '$lib/server/auth';
import { validateConsumerSession } from '$lib/server/identity/consumer-auth';
import { startEventPoller } from '$lib/server/agent/events';
import { startTelegramPoller } from '$lib/server/telegram/poller';
import { rateLimit } from '$lib/server/request-limit';

const PUBLIC = ['/login', '/setup'];
// Consumer-public surfaces reachable WITHOUT a consumer session: the login + onboarding
// pages and the endpoints they post to (a joining/logging-in consumer has no session yet).
// '/app/join' (the onboarding page) is matched as a prefix below.
// '/api/app/plex/pin' is the pre-onboarding PIN endpoint used by the join wizard BEFORE a
// consumer session exists; the gated post-onboarding /api/app/plex stays protected.
// '/api/app/showcase' is the PUBLIC poster-wall endpoint for the cinematic login/onboarding
// backdrops — it exposes only public TMDB poster URLs and is read before any session exists.
const CONSUMER_PUBLIC = ['/app/login', '/api/app/login', '/api/app/join', '/api/app/plex/pin', '/api/app/showcase', '/api/app/reset', '/api/app/contact', '/api/app/telegram/available'];

// ── Host-based access split (deploy-pinned via env, NOT in-app settings) ──
// When PULSE_PUBLIC_HOST is set, requests arriving on that hostname are restricted to the
// consumer PWA surface + the static/PWA assets it needs. Everything else (the entire admin
// surface) is invisible (plain 404 — never a redirect to /login). When unset, the guard is
// inactive and LAN behavior is unchanged. This is defense-in-depth behind the public tunnel:
// a compromised admin SESSION cannot widen the public surface because it's pinned at deploy.
function publicHost(): string {
  return (process.env.PULSE_PUBLIC_HOST ?? '').trim().toLowerCase();
}

// Exact static/PWA asset paths allowed on the public host.
const PUBLIC_ASSET_PATHS = new Set([
  '/manifest.webmanifest',
  '/service-worker.js',
  '/favicon.ico',
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/robots.txt'
]);

/** Is this path part of the consumer-visible surface allowed on the public host? */
function isPublicHostAllowed(path: string): boolean {
  if (path === '/app' || path.startsWith('/app/')) return true;
  if (path === '/api/app' || path.startsWith('/api/app/')) return true;
  if (path === '/api/image' || path.startsWith('/api/image/')) return true; // poster proxy (discover)
  if (path.startsWith('/_app/')) return true; // SvelteKit immutable JS/CSS — app won't load without it
  if (PUBLIC_ASSET_PATHS.has(path)) return true;
  return false;
}

/** Resolve the request host (x-forwarded-host > host header > url.host), lowercased, port-stripped. */
function requestHost(event: { request: Request; url: URL }): string {
  const raw =
    event.request.headers.get('x-forwarded-host') ||
    event.request.headers.get('host') ||
    event.url.host ||
    '';
  return raw.toLowerCase().split(':')[0].trim();
}

export const handle: Handle = async ({ event, resolve }) => {
  const db = getDb();
  // Kick off the background event poller exactly once (idempotent; no-op under PULSE_DISABLE_POLLER=1).
  startEventPoller(db);
  startTelegramPoller(db);

  // Resolve both sessions independently.
  const adminSid = event.cookies.get('pulse_session');
  event.locals.user = adminSid ? validateSession(db, adminSid) : null;
  const appSid = event.cookies.get('pulse_app');
  event.locals.consumer = appSid ? validateConsumerSession(db, appSid) : null;

  const path = event.url.pathname;

  // ── Abuse protection: in-memory per-IP request-rate limit on the consumer AI chat route
  //    (cost-amplification guard). Login/join/reset already have failure-based backoff in ratelimit.ts.
  if (event.request.method === 'POST' && path === '/api/app/chat') {
    const r = rateLimit(`chat:${event.getClientAddress()}`, 20, 60_000);
    if (!r.ok) return new Response('Too many requests. Slow down a moment.', { status: 429, headers: { 'Retry-After': String(r.retryAfter) } });
  }

  // ── Host guard (runs BEFORE setup/auth gates) ──
  // On the deploy-pinned public host, only the consumer surface + PWA assets are visible.
  // The admin surface returns a plain 404 (NOT a redirect to /login — it must be invisible).
  // B's consumer guards still apply below within the allowed consumer paths.
  const pubHost = publicHost();
  if (pubHost && requestHost(event) === pubHost) {
    if (path === '/') throw redirect(307, '/app'); // consumer entry
    if (!isPublicHostAllowed(path)) return new Response('Not found', { status: 404 });
    // Allowed consumer routes (/app, /api/app) fall through so B's consumer guard still applies.
    // Allowed static/PWA assets (/_app/, manifest, icons, poster proxy) are NOT consumer routes
    // and must NOT be caught by the admin guard below — serve them directly. (In production
    // adapter-node serves most of these before `handle` runs; this keeps the guard correct
    // regardless, and is the critical reason the app's immutable bundle loads on the public host.)
    // /service-worker.js falls through to its dedicated handler below so it still gets the
    // Service-Worker-Allowed: /app/ header (required for the PWA to register on the public host).
    const isConsumerRoute = path === '/app' || path.startsWith('/app/') || path === '/api/app' || path.startsWith('/api/app/');
    if (!isConsumerRoute && path !== '/service-worker.js') return resolve(event);
  }

  // The service worker is served from the origin root but must control the /app/ scope.
  // Browsers reject a registration scoped wider than the SW's own path unless the script
  // response carries Service-Worker-Allowed. Set it so register({ scope: '/app/' }) is allowed.
  // Handled before the setup/auth gates so the header is never swallowed by a redirect.
  if (path === '/service-worker.js') {
    const res = await resolve(event);
    res.headers.set('Service-Worker-Allowed', '/app/');
    return res;
  }

  const isAppRoute = path.startsWith('/app') || path.startsWith('/api/app');
  const isConsumerPublic = CONSUMER_PUBLIC.includes(path) || path.startsWith('/app/join') || path.startsWith('/app/reset');

  // First-run setup gate (admin only).
  if (!isSetup(db) && path !== '/setup') throw redirect(303, '/setup');
  if (isSetup(db) && path === '/setup') throw redirect(303, '/');

  // ── Consumer scope ──
  if (isAppRoute) {
    if (!event.locals.consumer && !isConsumerPublic) {
      if (path.startsWith('/api/')) throw error(401, 'Unauthorized');
      throw redirect(303, '/app/login');
    }
    return resolve(event); // consumers never fall through to the admin guard
  }

  // The media-poster proxy is usable by BOTH admin and consumer sessions (the endpoint itself
  // enforces user-OR-consumer); exempt it from the admin-only API gate so consumer PWA discover
  // posters load. A request with neither session is still rejected by the endpoint.
  const isImageProxy = path === '/api/image' || path.startsWith('/api/image/');

  // ── Admin scope ── (a consumer session does NOT grant admin access)
  if (!event.locals.user && !PUBLIC.includes(path) && !path.startsWith('/api/_public') && !path.startsWith('/api/'))
    throw redirect(303, '/login');
  if (path.startsWith('/api/') && !isImageProxy && !PUBLIC.includes(path) && !path.startsWith('/api/_public') && !event.locals.user)
    throw error(401, 'Unauthorized');

  return resolve(event);
};
