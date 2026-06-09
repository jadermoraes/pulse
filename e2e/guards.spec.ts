import { test, expect } from '@playwright/test';

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

test('unauthenticated consumer API is 401; admin API is 401; pages redirect', async ({ page }) => {
  await setupAndLogin(page);
  const fresh = await page.context().browser()!.newContext();
  try {
    expect((await fresh.request.get('/api/app/me')).status()).toBe(401);
    expect((await fresh.request.get('/api/roles')).status()).toBe(401);
  } finally { await fresh.close(); }
});

test('admin session cannot reach consumer-only /api/app/me', async ({ page }) => {
  await setupAndLogin(page);
  // Admin is logged in (pulse_session) but has no consumer session → 401 on /api/app/me.
  expect((await page.request.get('/api/app/me')).status()).toBe(401);
});

// '/app/login' exists as of Task 15.
test('consumer-public routes are reachable without a session', async ({ page }) => {
  const fresh = await page.context().browser()!.newContext();
  try {
    const r = await fresh.request.get('/app/login');
    expect(r.status()).toBeLessThan(400);
  } finally { await fresh.close(); }
});

// B.2 review finding #1: the pre-onboarding PIN endpoint must be reachable session-less
// while the post-onboarding /api/app/plex endpoint must stay consumer-gated (401).
test('/api/app/plex/pin is reachable without a consumer session; /api/app/plex stays gated', async ({ page }) => {
  await setupAndLogin(page);
  const fresh = await page.context().browser()!.newContext();
  try {
    // POST /api/app/plex/pin — public pre-onboarding endpoint: must NOT return 401.
    // (It may return 200 with a fake PIN or any non-401/403 status.)
    const pinRes = await fresh.request.post('/api/app/plex/pin');
    expect(pinRes.status(), '/api/app/plex/pin POST should not be 401').not.toBe(401);
    expect(pinRes.status(), '/api/app/plex/pin POST should not be 403').not.toBe(403);

    // POST /api/app/plex — consumer-gated post-onboarding endpoint: must return 401.
    const plexRes = await fresh.request.post('/api/app/plex');
    expect(plexRes.status(), '/api/app/plex POST must be 401 without a session').toBe(401);

    // GET /api/app/plex — same guard applies.
    const plexGetRes = await fresh.request.get('/api/app/plex?pinId=1');
    expect(plexGetRes.status(), '/api/app/plex GET must be 401 without a session').toBe(401);
  } finally { await fresh.close(); }
});
