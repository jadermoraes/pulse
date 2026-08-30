import { test, expect } from '@playwright/test';

// Shared helper — handles fresh DB (setup), already-set-up (login), or already logged in.
// Copied from e2e/connections.spec.ts / e2e/household-stremio.spec.ts.
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

const TOKEN_A = 'a'.repeat(48);
const TOKEN_B = 'b'.repeat(48);

// The app's service worker re-issues every same-origin GET from inside itself, which silently
// defeats page.route() GET mocks (POST/DELETE still work, so half the mocks appear fine).
// Block service workers for this context. Do NOT change the app's SW to suit the test.
test('admin mints the addon URL, sees the bearer warning, and revokes it', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  let state: {
    token: string | null; consumerId: number | null; label: string | null; lastUsedAt: number | null;
  } = { token: null, consumerId: null, label: null, lastUsedAt: null };
  let mints = 0;
  let lastPost: any = null;

  await page.route('**/api/addon', async (route) => {
    const m = route.request().method();
    if (m === 'GET') {
      return route.fulfill({
        json: {
          linked: state.token !== null,
          token: state.token,
          consumerId: state.consumerId,
          label: state.label,
          createdAt: state.token ? 1 : null,
          lastUsedAt: state.lastUsedAt,
          consumers: [{ id: 2, displayName: 'Jader' }, { id: 3, displayName: 'Jessica' }]
        }
      });
    }
    if (m === 'POST') {
      lastPost = JSON.parse(route.request().postData() ?? '{}');
      // Second mint hands back a DIFFERENT token, mirroring the server: minting revokes the old
      // one, so a panel that kept showing the first URL would be showing a dead URL.
      const token = ++mints === 1 ? TOKEN_A : TOKEN_B;
      state = { token, consumerId: lastPost.consumerId, label: lastPost.label ?? null, lastUsedAt: null };
      return route.fulfill({ json: { ok: true, token } });
    }
    if (m === 'DELETE') {
      state = { token: null, consumerId: null, label: null, lastUsedAt: null };
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });

  try {
    await setupAndLogin(page);
    await page.goto('/settings#connections');

    // The warnings are the whole point of the panel: they must be on screen before anything is
    // minted, not revealed alongside the URL.
    await expect(page.getByText(
      'Anyone with this URL can browse and play your whole library, and request titles as the chosen user. Treat it like a password.'
    )).toBeVisible();
    await expect(page.getByText('This URL only works on your local network.')).toBeVisible();

    await expect(page.getByText('No addon URL yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    await expect(page.getByText('The old URL stops working immediately.')).toHaveCount(0);

    await page.getByLabel('Requests are made as').selectOption({ label: 'Jessica' });
    await page.getByLabel('Name this install (optional)').fill('Living room TV');
    await page.getByRole('button', { name: 'Generate URL' }).click();

    const url = page.getByLabel('Stremio addon');
    await expect(url).toHaveValue(new RegExp(`^http://localhost:3000/api/_public/addon/${TOKEN_A}/manifest\\.json$`));
    expect(lastPost).toEqual({ consumerId: 3, label: 'Living room TV' });
    await expect(page.getByText('No addon URL yet.')).toHaveCount(0);
    await expect(page.getByText('Never used')).toBeVisible();

    // Once a token exists, regenerating is destructive — the warning must sit next to the button.
    await expect(page.getByText('The old URL stops working immediately.')).toBeVisible();
    await page.getByRole('button', { name: 'Generate a new URL' }).click();
    await expect(url).toHaveValue(new RegExp(`/${TOKEN_B}/manifest\\.json$`));

    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('No addon URL yet.')).toBeVisible();
    await expect(page.getByLabel('Stremio addon')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Generate URL' })).toBeVisible();
  } finally {
    await context.close();
  }
});
