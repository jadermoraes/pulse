import { test, expect } from '@playwright/test';

// Shared helper — handles fresh DB (setup), already-set-up (login), or already logged in.
// Copied from e2e/connections.spec.ts / e2e/settings-add-connection.spec.ts.
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

// The app's service worker re-issues every same-origin GET from inside itself, which silently
// defeats page.route() GET mocks (POST/PATCH/DELETE still work, so half the mocks appear fine).
// Block service workers for this context. Do NOT change the app's SW to suit the test.
test('admin links Stremio, picks participants, and unlinks', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  let linked = false;
  let participants: number[] = [];

  await page.route('**/api/stremio', async (route) => {
    const m = route.request().method();
    if (m === 'GET') {
      return route.fulfill({
        json: {
          linked, enabled: true, email: linked ? 'tv@home.lan' : '',
          participantIds: participants, lastSyncAt: null, lastError: null,
          consumers: [{ id: 2, displayName: 'Jader' }, { id: 3, displayName: 'Jessica' }]
        }
      });
    }
    if (m === 'POST') { linked = true; return route.fulfill({ json: { ok: true } }); }
    if (m === 'PATCH') {
      participants = JSON.parse(route.request().postData() ?? '{}').participantIds ?? [];
      return route.fulfill({ json: { ok: true, participantIds: participants } });
    }
    if (m === 'DELETE') { linked = false; participants = []; return route.fulfill({ json: { ok: true } }); }
    return route.continue();
  });

  try {
    await setupAndLogin(page);
    await page.goto('/settings#connections');

    await page.getByLabel('Stremio email').fill('tv@home.lan');
    await page.getByLabel('Stremio password').fill('hunter2');
    await page.getByRole('button', { name: 'Link Stremio' }).click();
    await expect(page.getByText('Linked as tv@home.lan')).toBeVisible();

    await page.getByLabel('Jader').check();
    await page.getByRole('button', { name: 'Save participants' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect(participants).toEqual([2]);

    await page.getByRole('button', { name: 'Unlink' }).click();
    await expect(page.getByText('Not linked.')).toBeVisible();
  } finally {
    await context.close();
  }
});
