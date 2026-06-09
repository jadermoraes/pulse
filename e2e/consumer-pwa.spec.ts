import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';

/**
 * End-to-end consumer PWA flow, hermetic + deterministic:
 *   PULSE_PROVISION_FAKE=1 → onboarding provisions a synthetic jellyfin+seerr identity (no live server)
 *   PULSE_AGENT_FAKE=1      → the consumer chat streams the scripted fake driver (no real LLM)
 *   PULSE_DISABLE_POLLER=1  → no background poll noise; we drive the events poll explicitly
 *
 * The one boundary we cannot fake through env is seerr's HTTP API (request create + the requests
 * widget that the ready-push branch reads), so we stand up a tiny in-process mock seerr server and
 * point the seerr connection at it. The actual OS/browser push can't run headless, so the
 * ready-push *delivery path* is asserted server-side: we run the REAL `pollEvents` against the same
 * SQLite DB the app server uses and assert the tracked `consumer_requests` row flips to
 * available + notified=1 (the same write `sendPush` is invoked behind).
 */

const SEERR_PORT = 5599;
const REQUEST_ID = 555;
const TMDB_ID = 100;

// Mutable state the mock flips: media status 2 (processing) → 5 (Available).
let mediaStatus = 2;

function startMockSeerr(): Promise<Server> {
  mediaStatus = 2;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${SEERR_PORT}`);
    const send = (body: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    // Create a request → return its seerr id.
    if (req.method === 'POST' && url.pathname === '/api/v1/request') {
      send({ id: REQUEST_ID, status: 1, media: { tmdbId: TMDB_ID, mediaType: 'movie', status: mediaStatus } });
      return;
    }
    // The requests widget the ready-push branch reads.
    if (req.method === 'GET' && url.pathname === '/api/v1/request') {
      send({
        results: [
          { id: REQUEST_ID, status: 2, type: 'movie', media: { tmdbId: TMDB_ID, mediaType: 'movie', status: mediaStatus } }
        ]
      });
      return;
    }
    // Media detail (title resolution for both create + widget).
    if (req.method === 'GET' && url.pathname === `/api/v1/movie/${TMDB_ID}`) {
      send({ title: 'Mock Movie', releaseDate: '2020-01-01', status: 'Released', posterPath: '/p.jpg' });
      return;
    }
    // Trending (home "hot" row) — keep it empty-ish; the flow doesn't depend on it.
    if (req.method === 'GET' && url.pathname === '/api/v1/discover/trending') {
      send({ results: [] });
      return;
    }
    res.statusCode = 404;
    send({});
  });
  return new Promise((resolve) => server.listen(SEERR_PORT, '127.0.0.1', () => resolve(server)));
}

async function setupAndLogin(page: import('@playwright/test').Page) {
  await page.goto('/');
  if (page.url().includes('/setup')) {
    await page.fill('input[name=email]', 'a@b.com');
    await page.fill('input[name=password]', 'password123');
    await page.click('button');
    await page.waitForURL((u) => !u.pathname.includes('/setup'), { timeout: 5000 });
  }
  if (page.url().includes('/login')) {
    await page.fill('input[name=email]', 'a@b.com');
    await page.fill('input[name=password]', 'password123');
    await page.click('button');
    await expect(page).toHaveURL('/');
  }
}

/**
 * Seed the jellyfin + seerr connections via the Settings `create` form action (seerr → our mock).
 * The e2e DB is shared across specs, and the consumer modules pick the FIRST enabled seerr
 * connection. Earlier specs seed a dead `http://seerr`, so we first disable every existing seerr
 * connection in the DB, then create our mock-backed one — making it the only enabled seerr.
 */
async function ensureConnections(page: import('@playwright/test').Page) {
  const db = new Database('./data/e2e.sqlite');
  try { db.prepare("update connections set enabled=0 where type='seerr'").run(); }
  finally { db.close(); }
  for (const c of [
    { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'K' },
    { type: 'seerr', name: `Seerr-${Date.now().toString(36)}`, baseUrl: `http://127.0.0.1:${SEERR_PORT}`, secret: 'S' }
  ]) {
    const res = await page.request.post('/settings?/create', {
      headers: { origin: 'http://localhost:3000' },
      form: { type: c.type, name: c.name, baseUrl: c.baseUrl, secret: c.secret }
    });
    expect(res.ok(), `seed ${c.type} connection`).toBeTruthy();
  }
}

test('onboard → home → request → status → ready push invoked → chat respects cap', async ({ page, browser }) => {
  const mock = await startMockSeerr();
  // Unique per run so this spec is robust against the cross-spec shared e2e DB
  // (role name + consumer username are UNIQUE; other specs also create a "Member"/"Ana").
  const uid = Date.now().toString(36);
  const roleName = `Viewer-${uid}`;
  const username = `cpwa_${uid}`;
  const displayName = `Cleo-${uid}`;
  try {
    await setupAndLogin(page);
    await ensureConnections(page);

    // Admin: role (discover+request+status, small cap) + invite.
    const roleRes = await page.request.post('/api/roles', {
      data: { name: roleName, allowList: ['discover', 'request', 'status'], monthlyTokenCap: 50000, autoApprove: false, seerrQuota: { movie: 5 } }
    });
    expect(roleRes.status()).toBe(201);
    const { id: roleId } = await roleRes.json();
    const invRes = await page.request.post('/api/invites', { data: { roleId } });
    expect(invRes.status()).toBe(201);
    const { token } = await invRes.json();

    const consumer = await browser.newContext();
    try {
      // 1) Onboard via the join API (fake provision → synthetic jellyfin+seerr identity).
      await consumer.request.post('/api/app/join', {
        data: { token, displayName, username, password: 'password123', language: 'en' }
      }).then((r) => expect(r.status()).toBe(201));

      const cp = await consumer.newPage();
      await cp.goto('/app/login');
      await cp.fill('input[autocomplete=username]', username);
      await cp.fill('input[autocomplete=current-password]', 'password123');
      await cp.click('.btn-p');
      await expect(cp).toHaveURL(/\/app$/);

      // 2) Hybrid home: greeting + ask bar + nav.
      await expect(cp.getByRole('heading', { name: new RegExp(`Hi, ${displayName}`) })).toBeVisible();
      await expect(cp.getByLabel('Ask the assistant')).toBeVisible();
      await expect(cp.getByRole('link', { name: 'Discover' })).toBeVisible();

      // 3) Request a (fake) title via the consumer-scoped endpoint (session-attributed).
      const reqRes = await cp.request.post('/api/app/request', { data: { tmdbId: TMDB_ID, mediaType: 'movie' } });
      expect(reqRes.ok(), 'create consumer request').toBeTruthy();
      const created = await reqRes.json();
      expect(created.seerrRequestId).toBe(REQUEST_ID);
      expect(created.status).toBe('pending');

      // 4) /app/requests shows the tracked request.
      await cp.goto('/app/requests');
      const row = cp.locator('li[data-status]').filter({ hasText: 'Mock Movie' });
      await expect(row).toBeVisible();

      // 5) Register a (dummy) push subscription so the ready-push branch has a target.
      await cp.request.post('/api/app/push/subscribe', {
        data: { endpoint: `https://push.example/endpoint-${uid}`, keys: { p256dh: 'BPpub', auth: 'authkey' } }
      }).then((r) => expect(r.ok()).toBeTruthy());

      // 6) Simulate the request becoming available, then run the REAL events poll against the
      //    same DB the server uses → asserts the server-side ready-push delivery path is invoked.
      mediaStatus = 5; // seerr now reports the media as Available
      // The app server runs with PULSE_DB=./data/e2e.sqlite, which is also where crypto.ts
      // persists its secret.key. Point this test process at the same DB so connection-secret
      // decryption (inside pollEvents → listConnections) uses the SAME key the server wrote.
      process.env.PULSE_DB = './data/e2e.sqlite';
      const { pollEvents } = await import('../src/lib/server/agent/events');
      const db = new Database('./data/e2e.sqlite');
      db.pragma('journal_mode = WAL');
      try {
        await pollEvents(db);
        const tracked = db.prepare(
          'select status, notified from consumer_requests where seerr_request_id=?'
        ).get(REQUEST_ID) as { status: string; notified: number };
        expect(tracked.status).toBe('available');
        expect(tracked.notified).toBe(1); // sendPush delivery path was invoked + one-shot marked
      } finally {
        db.close();
      }

      // 7) The consumer sees the request flipped to available.
      await cp.goto('/app/requests');
      await expect(cp.locator('li[data-status="available"]').filter({ hasText: 'Mock Movie' })).toBeVisible();

      // 8) Consumer chat streams the (fake) assistant reply.
      await cp.goto('/app/chat');
      await cp.fill('textarea', 'recommend me something');
      await cp.getByRole('button', { name: 'Send' }).click();
      await expect(cp.getByText("Here's what I found from the homelab.")).toBeVisible();

      // 9) Push the consumer over their cap, then chat → the cap message appears + input disabled.
      const db2 = new Database('./data/e2e.sqlite');
      try {
        const c = db2.prepare('select id from consumer_users where display_name=?').get(displayName) as { id: number };
        const period = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
        db2.prepare(
          `insert into usage_counters (consumer_id, period, tokens_used) values (?,?,?)
           on conflict(consumer_id, period) do update set tokens_used = ?`
        ).run(c.id, period, 999999, 999999);
      } finally {
        db2.close();
      }

      await cp.reload();
      await cp.fill('textarea', 'one more rec please');
      await cp.getByRole('button', { name: 'Send' }).click();
      await expect(cp.getByText(/reached your chat limit/)).toBeVisible();
      await expect(cp.locator('textarea')).toBeDisabled();
    } finally {
      await consumer.close();
    }
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
});
