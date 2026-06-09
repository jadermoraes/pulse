import { test, expect } from '@playwright/test';

// Handles three cases: fresh DB (setup), already-set-up (login), or already logged in (dashboard).
async function setupAndLogin(page: import('@playwright/test').Page) {
  await page.goto('/');
  const url = page.url();
  if (url.includes('/setup')) {
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

test('action + server + list endpoints require auth', async ({ page }) => {
  // Ensure DB is initialised before testing auth-gating (avoids a race with the foundation spec).
  await setupAndLogin(page);
  // Use a fresh browser context with no cookies to confirm endpoints are auth-gated.
  const unauthCtx = await page.context().browser()!.newContext();
  try {
    const req = unauthCtx.request;
    expect((await req.post('/api/actions/1/approve')).status()).toBe(401);
    expect((await req.get('/api/detail/1?kind=request&id=1')).status()).toBe(401);
    expect((await req.get('/api/docker/top')).status()).toBe(401);
    // /server is a page route — the hook redirects unauthenticated users to /login (303).
    const server = await req.get('/server', { maxRedirects: 0 });
    expect([301, 302, 303]).toContain(server.status());
  } finally {
    await unauthCtx.close();
  }
});

test('unknown action is rejected (allowlist) when authenticated', async ({ page }) => {
  await setupAndLogin(page);
  const cookies = await page.context().cookies();
  const sid = cookies.find((c) => c.name === 'pulse_session');
  expect(sid).toBeTruthy();
  // No connection id 1 exists → resolveAction returns ok:false (200 body), never executes anything.
  const res = await page.request.post('/api/actions/1/totally-fake-action', {
    headers: { Cookie: `pulse_session=${sid!.value}`, 'Content-Type': 'application/json' },
    data: {}
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false);
});

test('server sub-dashboard renders after login', async ({ page }) => {
  await setupAndLogin(page);
  await page.goto('/server');
  // Heading is always visible
  await expect(page.locator('h2')).toContainText('Server');
  // Container list section always present
  await expect(page.getByText('Top containers by CPU')).toBeVisible();
});
