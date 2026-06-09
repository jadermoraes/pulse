import { test, expect } from '@playwright/test';

/**
 * Password-reset flow — hermetic (PULSE_PROVISION_FAKE=1, no real Jellyfin).
 *
 * Covers:
 *  1. Invalid token  → /app/reset/<bad>  shows "Link expired" state.
 *  2. Happy path     → admin mints a link, consumer opens it, sets a new
 *                      password, page redirects to /app.
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

test('invalid reset token shows "Link expired" state', async ({ page }) => {
  // Ensure the admin account is created so the setup gate does not redirect /app/reset/* to /setup.
  await setupAndLogin(page);

  await page.goto('/app/reset/0000000000000000000000000000000000000000000000000000000000000000');
  await expect(page.getByText('Link expired')).toBeVisible();
  await expect(page.getByText('Back to sign in')).toBeVisible();
  // The set-password form must NOT be present in invalid state.
  await expect(page.getByText('Set password')).not.toBeVisible();
});

test('happy path: admin mints link → consumer sets new password → redirects to /app', async ({ page, browser }) => {
  await setupAndLogin(page);
  await ensureConnections(page);

  // 1) Create a role + invite + onboard a consumer (fake provision).
  const roleId = (
    await page.request
      .post('/api/roles', {
        data: {
          name: 'ResetMember',
          allowList: ['discover'],
          monthlyTokenCap: null,
          autoApprove: false,
          seerrQuota: {}
        }
      })
      .then((r) => r.json())
  ).id;

  const token = (
    await page.request.post('/api/invites', { data: { roleId } }).then((r) => r.json())
  ).token;

  const consumer = await browser.newContext();
  try {
    await consumer.request
      .post('/api/app/join', {
        data: { token, displayName: 'ResetUser', username: 'resetuser', password: 'oldpass123', language: 'en' }
      })
      .then((r) => expect(r.status()).toBe(201));

    // 2) Admin mints a reset link.
    const users = await page.request.get('/api/users').then((r) => r.json());
    const u = users.users.find((x: { displayName: string }) => x.displayName === 'ResetUser');
    expect(u, 'consumer must exist after onboarding').toBeTruthy();

    const resetRes = await page.request.post('/api/users/reset', { data: { id: u.id } });
    expect(resetRes.status()).toBe(200);
    const { link } = await resetRes.json();
    expect(link).toMatch(/^\/app\/reset\/[a-f0-9]{48}$/);

    // 3) Consumer opens the reset page — shows the set-password form (valid token).
    const cp = await consumer.newPage();
    await cp.goto(link);
    await expect(cp.getByText('Set a new password')).toBeVisible();
    await expect(cp.getByText('Set password')).toBeVisible();
    // Invalid-state heading must NOT appear.
    await expect(cp.getByText('Link expired')).not.toBeVisible();

    // 4) Fill in the new password and submit.
    await cp.fill('input[autocomplete=new-password]', 'newpass456');
    // There are two new-password inputs (password + confirm); fill both.
    const pwInputs = cp.locator('input[autocomplete=new-password]');
    await pwInputs.nth(0).fill('newpass456');
    await pwInputs.nth(1).fill('newpass456');
    await cp.click('.btn-p');

    // 5) Page redirects to /app on success (PULSE_PROVISION_FAKE=1 → setJellyfinPassword is a no-op).
    await expect(cp).toHaveURL(/\/app$/, { timeout: 8000 });
  } finally {
    await consumer.close();
  }
});
