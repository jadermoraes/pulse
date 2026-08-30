import { test, expect } from '@playwright/test';

/**
 * The watchlist view on /app/requests, hermetic + deterministic.
 *
 * The watchlist API is covered by its own server-side tests; this spec only checks the view
 * wiring, so /api/app/watchlist is mocked at the route level. An admin seeds connections + a
 * role + invite, a consumer onboards (fake provision) and logs in, then we intercept the
 * watchlist + detail endpoints on that consumer's page.
 */

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

async function ensureConnections(page: import('@playwright/test').Page) {
  for (const c of [
    { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'K' },
    { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'S' }
  ]) {
    const res = await page.request.post('/settings?/create', {
      headers: { origin: 'http://localhost:3000' },
      form: { type: c.type, name: c.name, baseUrl: c.baseUrl, secret: c.secret }
    });
    expect(res.ok(), `seed ${c.type} connection`).toBeTruthy();
  }
}

/** Onboards a fresh consumer (no Plex) in a new browser context and logs them in. */
async function newConsumer(
  browser: import('@playwright/test').Browser,
  page: import('@playwright/test').Page,
  username: string
) {
  const roleId = (
    await page.request
      .post('/api/roles', {
        data: {
          name: `Role-${username}`,
          allowList: ['discover', 'request', 'status', 'watchlist'],
          monthlyTokenCap: null,
          autoApprove: false,
          seerrQuota: {}
        }
      })
      .then((r) => r.json())
  ).id;
  const token = (await page.request.post('/api/invites', { data: { roleId } }).then((r) => r.json())).token;

  // Block the consumer PWA's service worker: it intercepts every same-origin GET (fetch event
  // handler) and re-issues it with its own fetch(), which bypasses page.route() for GET requests
  // (POST/DELETE are untouched by the SW and route normally). Without this, the GET mocks below
  // would silently hit the real endpoints instead.
  const consumer = await browser.newContext({ serviceWorkers: 'block' });
  await consumer.request
    .post('/api/app/join', { data: { token, displayName: username, username, password: 'password123', language: 'en' } })
    .then((r) => expect(r.status()).toBe(201));

  const cp = await consumer.newPage();
  await cp.goto('/app/login');
  await cp.fill('input[autocomplete=username]', username);
  await cp.fill('input[autocomplete=current-password]', 'password123');
  await cp.click('.btn-p');
  await expect(cp).toHaveURL(/\/app$/);
  return { consumer, cp };
}

test('watchlist view lists saved titles and removing one confirms first', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);
  const { consumer, cp } = await newConsumer(browser, page, 'watch1');
  try {
    // Newest first, exactly as the server returns it — the view must not re-sort.
    let rows = [
      { id: 1, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true, addedAt: 2 },
      { id: 2, tmdbId: 238, mediaType: 'movie', title: 'Godfather', onServer: true, notifyOnAvailable: false, addedAt: 1 }
    ];
    await cp.route('**/api/app/watchlist', async (route) => {
      if (route.request().method() === 'DELETE') {
        // Pin the whole body: the handler coerces any non-'tv' mediaType to 'movie', so a client
        // that sent the wrong field name (or none) would silently misroute a series removal.
        expect(JSON.parse(route.request().postData()!)).toEqual({ tmdbId: 278, mediaType: 'movie' });
        const tmdbId = JSON.parse(route.request().postData() ?? '{}').tmdbId;
        rows = rows.filter((r) => r.tmdbId !== tmdbId);
        return route.fulfill({ json: { ok: true, household: true } });
      }
      return route.fulfill({ json: rows });
    });
    await cp.route('**/api/app/detail*', (route) => route.fulfill({ json: {} }));

    await cp.goto('/app/requests');
    await cp.getByRole('tab', { name: 'Watchlist' }).click();
    await expect(cp.getByText('Shawshank')).toBeVisible();
    await expect(cp.getByText('Godfather')).toBeVisible();

    // First click asks; the row is still there.
    await cp.getByRole('button', { name: 'Remove', exact: true }).first().click();
    await expect(cp.getByText('Shawshank')).toBeVisible();
    // Confirming removes it.
    await cp.getByRole('button', { name: 'Remove for everyone?' }).click();
    await expect(cp.getByText('Shawshank')).toHaveCount(0);
    await expect(cp.getByText('Godfather')).toBeVisible();
  } finally {
    await consumer.close();
  }
});
