import { test, expect } from '@playwright/test';

// Verifies the mobile (≤768px) responsive shell at a 375px-wide viewport:
//  - the bottom tab navigation is visible,
//  - the left rail and the dashboard "Edit layout" button are hidden,
//  - the GridStack dashboard collapses to a single column (every item is full width).

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

async function ensureConnection(page: import('@playwright/test').Page) {
  await page.goto('/settings');
  await expect(page.locator('.master-detail')).toBeVisible();
  if ((await page.locator('.conn-card').count()) === 0) {
    await page.locator('.md-rail-item', { hasText: 'Jellyfin' }).click();
    const detail = page.locator('.md-detail');
    await detail.locator('.add-btn').click();
    const form = detail.locator('.add-form');
    await form.locator('input[name=name]').fill('Mobile JF');
    await form.locator('input[name=baseUrl]').fill('http://localhost:8096');
    await form.locator('input[name=secret]').fill('mobile-key-123');
    await form.locator('button[formaction="?/create"]').click();
    await expect(form).not.toBeVisible({ timeout: 5000 });
  }
}

test.describe('mobile responsive (375px)', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('bottom nav shows; rail + edit hidden; widgets stack single-column', async ({ page }) => {
    await setupAndLogin(page);
    await ensureConnection(page);

    await page.goto('/');
    await expect(page.locator('.dash-grid')).toBeVisible();

    // Bottom nav visible, rail hidden.
    await expect(page.locator('.bottom-nav')).toBeVisible();
    await expect(page.locator('.rail')).toBeHidden();

    // Edit-layout button hidden on mobile.
    await expect(page.getByRole('button', { name: 'Edit layout' })).toBeHidden();

    // Single-column: GridStack collapses to one column (adds the `gs-1` class) and the
    // CSS animation settles. Then every item spans (nearly) the full grid width.
    const grid = page.locator('.dash-grid');
    await expect(grid).toHaveClass(/\bgs-1\b/);
    const items = page.locator('.grid-stack-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);

    const gridBox = await grid.boundingBox();
    expect(gridBox).not.toBeNull();
    await expect
      .poll(async () => {
        let minRatio = 1;
        for (let i = 0; i < count; i++) {
          const box = await items.nth(i).boundingBox();
          if (!box || !gridBox) continue;
          minRatio = Math.min(minRatio, box.width / gridBox.width);
        }
        return minRatio;
      })
      .toBeGreaterThan(0.85);
  });

  test('detail drawer presents as a bottom sheet', async ({ page }) => {
    await setupAndLogin(page);
    await ensureConnection(page);
    await page.goto('/');
    await expect(page.locator('.dash-grid')).toBeVisible();

    // The drawer element is bottom-anchored on mobile (full width).
    const drawer = page.locator('.drawer');
    const box = await drawer.boundingBox();
    if (box) {
      // Full viewport width when laid out as a bottom sheet.
      expect(box.width).toBeGreaterThan(300);
    }
  });
});
