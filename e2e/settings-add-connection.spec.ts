import { test, expect } from '@playwright/test';

// Shared helper — handles fresh DB (setup), already-set-up (login), or already logged in.
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

/**
 * Regression guard: the master-detail "Add connection" save flow must persist
 * the new connection to the DB and show the connection card in the detail pane.
 *
 * Uses Jellyfin (baseUrl + secret) — no live service required; we only click
 * Save (not Test), so the action never makes an outbound HTTP call.
 */
test('settings: adding a Jellyfin connection via master-detail persists and shows the card', async ({ page }) => {
  await setupAndLogin(page);

  // Navigate to settings (connections tab is default)
  await page.goto('/settings');

  // Wait for the master-detail layout to be visible
  await expect(page.locator('.master-detail')).toBeVisible();

  // Count existing Jellyfin cards before adding
  // Select the Jellyfin type in the left rail
  const jellyfinRailBtn = page.locator('.md-rail-item', { hasText: 'Jellyfin' });
  await expect(jellyfinRailBtn).toBeVisible();
  await jellyfinRailBtn.click();

  // Wait for the detail pane to show Jellyfin
  const detailPane = page.locator('.md-detail');
  await expect(detailPane).toBeVisible();
  await expect(detailPane.locator('h3', { hasText: 'Jellyfin' })).toBeVisible();

  // Count existing conn cards before adding
  const cardsBefore = await detailPane.locator('.conn-card').count();

  // Click "+ Add"
  const addBtn = detailPane.locator('.add-btn');
  await expect(addBtn).toBeVisible();
  await addBtn.click();

  // The add form should appear
  const addForm = detailPane.locator('.add-form');
  await expect(addForm).toBeVisible();

  // Fill in Name
  await addForm.locator('input[name=name]').fill('Test Jellyfin');

  // Fill in Server URL (baseUrl field)
  await addForm.locator('input[name=baseUrl]').fill('http://localhost:8096');

  // Fill in API Key (secret field)
  await addForm.locator('input[name=secret]').fill('test-api-key-abc123');

  // Click Save (not Test — no live service needed)
  await addForm.locator('button[formaction="?/create"]').click();

  // After save, the add form should close and the new card should appear
  // (the enhance callback sets addOpenType = null on created: true)
  await expect(addForm).not.toBeVisible({ timeout: 5000 });

  // The connection card count should have increased by 1
  await expect(detailPane.locator('.conn-card')).toHaveCount(cardsBefore + 1, { timeout: 5000 });

  // The new card should show the connection name
  await expect(detailPane.locator('.conn-name', { hasText: 'Test Jellyfin' })).toBeVisible();

  // No error banner should be visible
  await expect(page.locator('.err')).not.toBeVisible();
});

/**
 * Regression guard for Proxmox — which has extra fields (tokenId, node).
 * Verifies that extra schema fields are submitted and the connection is persisted.
 * Only clicks Save (no live PVE node needed).
 */
test('settings: adding a Proxmox connection with extra fields persists and shows the card', async ({ page }) => {
  await setupAndLogin(page);

  await page.goto('/settings');
  await expect(page.locator('.master-detail')).toBeVisible();

  // Select Proxmox in the left rail
  const proxmoxRailBtn = page.locator('.md-rail-item', { hasText: 'Proxmox' });
  await expect(proxmoxRailBtn).toBeVisible();
  await proxmoxRailBtn.click();

  const detailPane = page.locator('.md-detail');
  await expect(detailPane.locator('h3', { hasText: 'Proxmox' })).toBeVisible();

  const cardsBefore = await detailPane.locator('.conn-card').count();

  // Click "+ Add"
  await detailPane.locator('.add-btn').click();

  const addForm = detailPane.locator('.add-form');
  await expect(addForm).toBeVisible();

  // Fill required fields
  await addForm.locator('input[name=name]').fill('Test PVE');
  await addForm.locator('input[name=baseUrl]').fill('https://192.168.1.20:8006');
  await addForm.locator('input[name=tokenId]').fill('pulse@pve!token');
  await addForm.locator('input[name=secret]').fill('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  // node is optional — leave blank

  // Click Save
  await addForm.locator('button[formaction="?/create"]').click();

  // Add form should close
  await expect(addForm).not.toBeVisible({ timeout: 5000 });

  // Card count should increase
  await expect(detailPane.locator('.conn-card')).toHaveCount(cardsBefore + 1, { timeout: 5000 });

  // Card name should be visible
  await expect(detailPane.locator('.conn-name', { hasText: 'Test PVE' })).toBeVisible();

  // No error banner
  await expect(page.locator('.err')).not.toBeVisible();
});
