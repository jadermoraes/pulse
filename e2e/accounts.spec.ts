import { test, expect } from '@playwright/test';

/**
 * Full accounts flow, hermetic + deterministic (PULSE_PROVISION_FAKE=1 — no live
 * Jellyfin/seerr/LLM): admin logs in → creates a role → mints an invite → a consumer
 * onboards through the join endpoint (fake provision) → logs in (federated against the
 * fake) → lands on My Account showing usage + plan → the admin changes their role and the
 * change reflects in what the consumer's account reports.
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

/**
 * Seed the jellyfin + seerr connections provisioning requires, via the Settings `create`
 * form action (no JSON `/api/connections` endpoint exists). `createConnection` defaults to
 * enabled, which is what `provisionConsumer` looks for. Idempotency is unnecessary on the
 * fresh e2e DB but harmless if duplicated.
 */
async function ensureConnections(page: import('@playwright/test').Page) {
  for (const c of [
    { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'K' },
    { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'S' }
  ]) {
    // SvelteKit rejects cross-site form POSTs (CSRF); send a same-origin Origin header so the
    // action runs. Fail loudly if it doesn't persist — provisioning depends on these.
    const res = await page.request.post('/settings?/create', {
      headers: { origin: 'http://localhost:3000' },
      form: { type: c.type, name: c.name, baseUrl: c.baseUrl, secret: c.secret }
    });
    expect(res.ok(), `seed ${c.type} connection`).toBeTruthy();
  }
}

test('full accounts flow: role → invite → onboard → login → My Account → role change', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);

  // 1) Admin creates a role.
  const roleRes = await page.request.post('/api/roles', {
    data: { name: 'Member', allowList: ['discover', 'request', 'status'], monthlyTokenCap: 50000, autoApprove: false, seerrQuota: { movie: 5 } }
  });
  expect(roleRes.status()).toBe(201);
  const { id: roleId } = await roleRes.json();

  // 2) Admin mints an invite.
  const invRes = await page.request.post('/api/invites', { data: { roleId } });
  expect(invRes.status()).toBe(201);
  const { token } = await invRes.json();

  // 3) Onboarding provisions a FAKE jellyfin+seerr user (PULSE_PROVISION_FAKE=1).
  const consumer = await browser.newContext();
  try {
    await consumer.request.post('/api/app/join', {
      data: { token, displayName: 'Ana', username: 'ana', password: 'password123', language: 'pt-BR' }
    }).then((r) => expect(r.status()).toBe(201));

    // 4) Consumer logs in (fresh context, federated against fake Jellyfin).
    const cp = await consumer.newPage();
    await cp.goto('/app/login');
    await cp.fill('input[autocomplete=username]', 'ana');
    await cp.fill('input[autocomplete=current-password]', 'password123');
    await cp.click('.btn-p');
    await expect(cp).toHaveURL(/\/app$/);

    // 5) My Account (relocated to /app/account in Sub-project D) shows usage + plan.
    await cp.goto('/app/account');
    await expect(cp.locator('.app-usage')).toBeVisible();
    await expect(cp.getByText('Member')).toBeVisible();
  } finally { await consumer.close(); }

  // 6) Admin sees the user and can change their role (create a 2nd role, PATCH).
  const role2 = await page.request.post('/api/roles', {
    data: { name: 'Power', allowList: ['discover', 'request', 'status', 'watchlist'], monthlyTokenCap: null, autoApprove: true, seerrQuota: {} }
  }).then((r) => r.json());
  const users = await page.request.get('/api/users').then((r) => r.json());
  const u = users.users.find((x: { displayName: string }) => x.displayName === 'Ana');
  expect(u).toBeTruthy();
  const patch = await page.request.patch('/api/users', { data: { id: u.id, roleId: role2.id } });
  expect(patch.ok()).toBeTruthy();
  const after = await page.request.get('/api/users').then((r) => r.json());
  expect(after.users.find((x: { id: number }) => x.id === u.id).roleName).toBe('Power');
});

test('disabled consumer cannot log in', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);
  const roleId = (await page.request.post('/api/roles', { data: { name: 'M2', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} } }).then((r) => r.json())).id;
  const token = (await page.request.post('/api/invites', { data: { roleId } }).then((r) => r.json())).token;
  const consumer = await browser.newContext();
  try {
    await consumer.request.post('/api/app/join', { data: { token, displayName: 'Bo', username: 'bo', password: 'password123' } });
    const users = await page.request.get('/api/users').then((r) => r.json());
    const u = users.users.find((x: { displayName: string }) => x.displayName === 'Bo');
    await page.request.patch('/api/users', { data: { id: u.id, status: 'disabled' } });
    const cp = await consumer.newPage();
    await cp.goto('/app/login');
    await cp.fill('input[autocomplete=username]', 'bo');
    await cp.fill('input[autocomplete=current-password]', 'password123');
    await cp.click('.btn-p');
    await expect(cp.locator('.app-error')).toBeVisible();
  } finally { await consumer.close(); }
});
