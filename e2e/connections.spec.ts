import { test, expect } from '@playwright/test';

/**
 * Connections UI (Stremio + Trakt) on My Account, hermetic + deterministic.
 *
 * Both spokes' backend endpoints are already covered by their own tests; this spec only checks
 * the panel wiring, so the network is mocked at the route level (page.route) rather than driving
 * the real Stremio/Trakt HTTP calls. An admin seeds connections + a role + invite, a consumer
 * onboards (fake provision) and logs in, then we intercept /api/app/stremio and /api/app/trakt on
 * that consumer's page before visiting /app/account.
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
        data: { name: `Role-${username}`, allowList: ['discover', 'request', 'status'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} }
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

test('Stremio: unlinked shows the form; a successful connect switches to Connected', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);
  const { consumer, cp } = await newConsumer(browser, page, 'streamer1');
  try {
    let linked = false;
    await cp.route('**/api/app/stremio', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({ json: { linked, enabled: linked, lastSyncAt: null, lastError: null } });
      } else if (req.method() === 'POST') {
        linked = true;
        await route.fulfill({ json: { ok: true } });
      } else {
        await route.continue();
      }
    });
    await cp.route('**/api/app/trakt', (route) =>
      route.fulfill({ json: { configured: false, linked: false, enabled: false, lastSyncAt: null, lastError: null } })
    );

    await cp.goto('/app/account');
    await expect(cp.getByLabel('Stremio email')).toBeVisible();

    await cp.getByLabel('Stremio email').fill('me@example.com');
    await cp.getByLabel('Stremio password').fill('hunter2');
    await cp.getByRole('button', { name: 'Connect Stremio' }).click();

    await expect(cp.getByText('Connected', { exact: true })).toBeVisible();
    await expect(cp.getByLabel('Stremio email')).toHaveCount(0);
  } finally {
    await consumer.close();
  }
});

test('Stremio: a 400 shows the bad-credentials copy and leaves the panel unlinked', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);
  const { consumer, cp } = await newConsumer(browser, page, 'streamer2');
  try {
    await cp.route('**/api/app/stremio', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({ json: { linked: false, enabled: false, lastSyncAt: null, lastError: null } });
      } else if (req.method() === 'POST') {
        await route.fulfill({ status: 400, json: { message: 'Stremio rejected those credentials' } });
      } else {
        await route.continue();
      }
    });
    await cp.route('**/api/app/trakt', (route) =>
      route.fulfill({ json: { configured: false, linked: false, enabled: false, lastSyncAt: null, lastError: null } })
    );

    await cp.goto('/app/account');
    await cp.getByLabel('Stremio email').fill('me@example.com');
    await cp.getByLabel('Stremio password').fill('wrong');
    await cp.getByRole('button', { name: 'Connect Stremio' }).click();

    await expect(cp.getByText("Stremio didn't accept that email and password.")).toBeVisible();
    // Still unlinked — the form (not the Connected badge) is still showing.
    await expect(cp.getByLabel('Stremio email')).toBeVisible();
  } finally {
    await consumer.close();
  }
});

test('Trakt: not configured shows the notice and no Connect button', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);
  const { consumer, cp } = await newConsumer(browser, page, 'trakt1');
  try {
    await cp.route('**/api/app/stremio', (route) =>
      route.fulfill({ json: { linked: false, enabled: false, lastSyncAt: null, lastError: null } })
    );
    await cp.route('**/api/app/trakt', (route) =>
      route.fulfill({ json: { configured: false, linked: false, enabled: false, lastSyncAt: null, lastError: null } })
    );

    await cp.goto('/app/account');
    await expect(cp.getByText('Trakt is not set up on this server.')).toBeVisible();
    await expect(cp.getByRole('button', { name: 'Connect Trakt' })).toHaveCount(0);
  } finally {
    await consumer.close();
  }
});

test('Trakt: device flow shows the user code, then a poll returning ok switches to Connected', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);
  const { consumer, cp } = await newConsumer(browser, page, 'trakt2');
  try {
    await cp.route('**/api/app/stremio', (route) =>
      route.fulfill({ json: { linked: false, enabled: false, lastSyncAt: null, lastError: null } })
    );

    let linked = false;
    let pollCount = 0;
    await cp.route('**/api/app/trakt', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({ json: { configured: true, linked, enabled: linked, lastSyncAt: null, lastError: null } });
        return;
      }
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        if (body.action === 'start') {
          await route.fulfill({
            json: { deviceCode: 'dc123', userCode: 'ABCD-1234', verificationUrl: 'https://trakt.tv/activate', interval: 1 }
          });
          return;
        }
        if (body.action === 'poll') {
          pollCount++;
          linked = true;
          await route.fulfill({ json: { status: 'ok' } });
          return;
        }
      }
      await route.continue();
    });

    await cp.goto('/app/account');
    await cp.getByRole('button', { name: 'Connect Trakt' }).click();

    await expect(cp.getByText('ABCD-1234')).toBeVisible();
    await expect(cp.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10000 });
    expect(pollCount).toBeGreaterThan(0);
  } finally {
    await consumer.close();
  }
});
