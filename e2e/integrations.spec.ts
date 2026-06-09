import { test, expect } from '@playwright/test';

// Reuse the first-run flow to obtain an authenticated session.
// Handles three cases: fresh DB (setup), already-set-up (login), or already logged in (dashboard).
async function setupAndLogin(page: import('@playwright/test').Page) {
  await page.goto('/');
  const url = page.url();
  if (url.includes('/setup')) {
    await page.fill('input[name=email]', 'a@b.com');
    await page.fill('input[name=password]', 'password123');
    await page.click('button');
    // After setup, may land on '/' or be redirected to '/login' if another worker set up first.
    await page.waitForURL((u) => !u.pathname.includes('/setup'), { timeout: 5000 });
  }
  if (page.url().includes('/login')) {
    await page.fill('input[name=email]', 'a@b.com');
    await page.fill('input[name=password]', 'password123');
    await page.click('button');
    await expect(page).toHaveURL('/');
  }
}

test('server stats + docker endpoints require auth (unauthenticated request)', async ({ page }) => {
  // Ensure DB is initialised before testing auth-gating (avoids a race with the foundation spec).
  await setupAndLogin(page);
  // Use a fresh browser context with no cookies to confirm endpoints are auth-gated.
  const unauthCtx = await page.context().browser()!.newContext();
  try {
    const req = unauthCtx.request;
    expect((await req.get('/api/server/stats')).status()).toBe(401);
    expect((await req.get('/api/docker/containers')).status()).toBe(401);
    expect((await req.post('/api/docker/containers/abc/restart')).status()).toBe(401);
  } finally {
    await unauthCtx.close();
  }
});

test('docker action endpoint is real & auth-gated (no longer a 501 stub)', async ({ page }) => {
  await setupAndLogin(page);
  const cookies = await page.context().cookies();
  const sid = cookies.find((c) => c.name === 'pulse_session');
  expect(sid).toBeTruthy();
  // No real socket in CI → the module degrades; the endpoint returns 200 with ok:false (graceful), not 501.
  const res = await page.request.post('/api/docker/containers/abc/restart', {
    headers: { Cookie: `pulse_session=${sid!.value}` }
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false); // no socket available in test env → graceful failure
});

test('server stats widget renders in the top bar after login', async ({ page }) => {
  await setupAndLogin(page);
  // ServerStats shows either live chips or the unavailable fallback — both contain the button.
  await expect(page.locator('.server-btn')).toBeVisible();
});
