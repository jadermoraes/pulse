import { test, expect } from '@playwright/test';

test('first-run setup then reach the dashboard', async ({ page }) => {
  await page.goto('/');                         // redirected to /setup
  await expect(page).toHaveURL(/\/setup/);
  await page.fill('input[name=email]', 'a@b.com');
  await page.fill('input[name=password]', 'password123');
  await page.click('button');
  await expect(page).toHaveURL('/');            // logged in
  await expect(page.getByText('Add your first connection')).toBeVisible();
});

test('widget API requires auth', async ({ request }) => {
  const res = await request.get('/api/widgets/1/recentlyAdded');
  expect(res.status()).toBe(401);
});

test('most-watched API requires auth', async ({ request }) => {
  const res = await request.get('/api/most-watched');
  expect(res.status()).toBe(401);
});

test('/api/config/export requires auth', async ({ request }) => {
  const res = await request.get('/api/config/export');
  expect(res.status()).toBe(401);
});

test('/api/config/import requires auth', async ({ request }) => {
  const res = await request.post('/api/config/import', { data: 'version: 1\nconnections: []', headers: { 'Content-Type': 'text/yaml' } });
  expect(res.status()).toBe(401);
});
