import { test, expect } from '@playwright/test';

/**
 * B.2 Plex link, hermetic + deterministic (PULSE_PROVISION_FAKE=1 — no live Plex/WatchState):
 * an admin seeds connections + a role + invite, a consumer onboards (fake provision) and logs in,
 * then clicks "Link Plex" on My Account. The fakes make createPlexPin/pollPlexPin/
 * plexAccountFromToken resolve deterministically, so the flow completes and My Account shows the
 * "Plex linked" badge while /api/app/me reports plexLinked: true.
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

test('consumer links Plex from My Account → Plex linked badge + me.plexLinked', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);

  const roleId = (await page.request.post('/api/roles', {
    data: { name: 'PlexMember', allowList: ['discover', 'request', 'status'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} }
  }).then((r) => r.json())).id;
  const token = (await page.request.post('/api/invites', { data: { roleId } }).then((r) => r.json())).token;

  const consumer = await browser.newContext();
  try {
    // Onboard WITHOUT Plex (B.1 path) so we can link it afterward from My Account.
    await consumer.request.post('/api/app/join', {
      data: { token, displayName: 'Plexa', username: 'plexa', password: 'password123', language: 'en' }
    }).then((r) => expect(r.status()).toBe(201));

    const cp = await consumer.newPage();
    // The link flow calls window.open(authUrl) to app.plex.tv — keep the popup from navigating
    // anywhere real by stubbing window.open (the fake PIN poll drives completion, not the popup).
    await cp.addInitScript(() => { window.open = () => null; });

    await cp.goto('/app/login');
    await cp.fill('input[autocomplete=username]', 'plexa');
    await cp.fill('input[autocomplete=current-password]', 'password123');
    await cp.click('.btn-p');
    await expect(cp).toHaveURL(/\/app$/);

    // Account (with the Plex-link control) relocated to /app/account in Sub-project D.
    await cp.goto('/app/account');

    // Not linked yet.
    await expect(cp.getByText('Link Plex', { exact: true })).toBeVisible();

    // Click Link Plex → fake PIN flow completes on the first poll (~3s).
    await cp.getByText('Link Plex', { exact: true }).click();
    await expect(cp.locator('.badge-ok')).toBeVisible({ timeout: 15000 });
    await expect(cp.getByText('Plex linked')).toBeVisible();

    // /api/app/me confirms the server-side state.
    const me = await cp.request.get('/api/app/me').then((r) => r.json());
    expect(me.plexLinked).toBe(true);
  } finally { await consumer.close(); }
});
