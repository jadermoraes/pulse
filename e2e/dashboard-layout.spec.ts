import { test, expect } from '@playwright/test';

// Shared helper — handles fresh DB (setup), already-set-up (login), or already logged in.
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
 * Once at least one connection exists, the dashboard renders the editable grid.
 * This guards: the 12-column grid is present, and the "Edit layout" toggle reveals
 * the edit-mode chrome (and a "Done" button to exit).
 */
test('dashboard renders the layout grid and the edit toggle works', async ({ page }) => {
  await setupAndLogin(page);

  // Ensure at least one connection exists so the grid (not the empty state) renders.
  await page.goto('/settings');
  await expect(page.locator('.master-detail')).toBeVisible();
  if ((await page.locator('.conn-card').count()) === 0) {
    await page.locator('.md-rail-item', { hasText: 'Jellyfin' }).click();
    const detail = page.locator('.md-detail');
    await detail.locator('.add-btn').click();
    const form = detail.locator('.add-form');
    await form.locator('input[name=name]').fill('Dash JF');
    await form.locator('input[name=baseUrl]').fill('http://localhost:8096');
    await form.locator('input[name=secret]').fill('dash-key-123');
    await form.locator('button[formaction="?/create"]').click();
    await expect(form).not.toBeVisible({ timeout: 5000 });
  }

  await page.goto('/');

  // The 12-column dashboard grid is present.
  const grid = page.locator('.dash-grid');
  await expect(grid).toBeVisible();

  // The Edit layout toggle exists.
  const editToggle = page.getByRole('button', { name: 'Edit layout' });
  await expect(editToggle).toBeVisible();

  // FIX 1 — the widget's OWN header (a .card > .ch wrapper or a bare .card > h3) is visible
  // in VIEW mode. Measure its visibility + the body content's top offset before editing.
  const firstCard = page.locator('.dash-grid .wf-body .card').first();
  const ownHeader = firstCard.locator(':scope > .ch, :scope > h3').first();
  await expect(ownHeader).toBeVisible();
  const view = await firstCard.evaluate((card) => {
    const hd = card.querySelector(':scope > .ch, :scope > h3') as HTMLElement;
    const body = card.querySelector(':scope > div:not(.ch), :scope > p, :scope > .clist') as HTMLElement | null;
    return {
      headerVisibility: getComputedStyle(hd).visibility,
      headerBottom: Math.round(hd.getBoundingClientRect().bottom),
      bodyTop: body ? Math.round(body.getBoundingClientRect().top) : null
    };
  });
  expect(view.headerVisibility).toBe('visible');

  // Entering edit mode reveals the drag handle and a Done button. Sizing is done by
  // dragging the native resize handles (no size chips/buttons exist anymore).
  await editToggle.click();
  await expect(page.locator('.dash-grid.is-editing')).toBeVisible();
  await expect(page.locator('.wf-drag').first()).toBeVisible();
  await expect(page.locator('.wf-chip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();

  // FIX 1 — in EDIT mode the widget's own header is hidden via visibility:hidden (NOT
  // display:none), so the frame's overlay title is the ONLY title (no overlap) AND the
  // header keeps its layout space, so the content below does NOT shift vs view mode.
  const edit = await firstCard.evaluate((card) => {
    const hd = card.querySelector(':scope > .ch, :scope > h3') as HTMLElement;
    const body = card.querySelector(':scope > div:not(.ch), :scope > p, :scope > .clist') as HTMLElement | null;
    return {
      headerVisibility: getComputedStyle(hd).visibility,
      headerBottom: Math.round(hd.getBoundingClientRect().bottom),
      bodyTop: body ? Math.round(body.getBoundingClientRect().top) : null
    };
  });
  expect(edit.headerVisibility).toBe('hidden');
  // No content shift: the header still occupies its space (same bottom) and the body content
  // stays at the same vertical offset between modes.
  expect(Math.abs(edit.headerBottom - view.headerBottom)).toBeLessThanOrEqual(2);
  if (view.bodyTop !== null && edit.bodyTop !== null) {
    expect(Math.abs(edit.bodyTop - view.bodyTop)).toBeLessThanOrEqual(2);
  }

  // Exit edit mode.
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.dash-grid.is-editing')).toHaveCount(0);
});

/**
 * Hide a widget via the API → it appears in the tray → click show → it reappears in a
 * non-overlapping position (auto-placed into free space, not on top of another widget).
 *
 * This test uses the layout API directly to set up the hidden state, then reloads the page
 * so the tray is visible from the start — avoiding any cross-test state issues with the
 * interactive hide button.
 */
test('hidden widget shown from tray auto-places without overlapping another widget', async ({ page }) => {
  await setupAndLogin(page);

  // Ensure at least one connection so the grid renders.
  await page.goto('/settings');
  await expect(page.locator('.master-detail')).toBeVisible();
  if ((await page.locator('.conn-card').count()) === 0) {
    await page.locator('.md-rail-item', { hasText: 'Jellyfin' }).click();
    const detail = page.locator('.md-detail');
    await detail.locator('.add-btn').click();
    const form = detail.locator('.add-form');
    await form.locator('input[name=name]').fill('Tray JF');
    await form.locator('input[name=baseUrl]').fill('http://localhost:8096');
    await form.locator('input[name=secret]').fill('tray-key-123');
    await form.locator('button[formaction="?/create"]').click();
    await expect(form).not.toBeVisible({ timeout: 5000 });
  }

  // POST a layout to the API where "nowplaying" is hidden and the other widgets have
  // overlapping positions at (0,0) — simulating the BUG scenario.
  // "containers" is at (0,0,4,2). "nowplaying" is hidden but saved with x=0,y=0 (stale).
  // When the user clicks "show", WITHOUT the fix it would land at (0,0) on top of containers.
  // WITH the fix, x/y are cleared so GridStack auto-places it into free space.
  const layoutPayload = [
    { key: 'nowplaying', x: 0, y: 0, w: 6, h: 1, visible: false, collapsed: false },
    { key: 'watch',      x: 6, y: 0, w: 4, h: 2, visible: true,  collapsed: false },
    { key: 'containers', x: 0, y: 0, w: 4, h: 2, visible: true,  collapsed: false }
  ];
  await page.goto('/');
  await page.waitForTimeout(200);
  // Use fetch to POST the layout (session cookie is active from setupAndLogin).
  const postResult = await page.evaluate(async (payload) => {
    const res = await fetch('/api/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.ok;
  }, layoutPayload);
  expect(postResult, 'layout POST failed').toBe(true);

  // Reload the page so the server data reflects the new layout.
  await page.reload();
  await expect(page.locator('.dash-grid')).toBeVisible();
  await page.waitForTimeout(400);

  // The grid should show 2 visible widgets (watch + containers, NOT nowplaying).
  await expect(page.locator('.grid-stack-item[gs-id="watch"]')).toBeVisible();
  await expect(page.locator('.grid-stack-item[gs-id="containers"]')).toBeVisible();
  await expect(page.locator('.grid-stack-item[gs-id="nowplaying"]')).toHaveCount(0);

  // Enter edit mode — the hidden-tray should be visible with the "Now Playing" chip.
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await expect(page.locator('.dash-grid.is-editing')).toBeVisible();
  await page.waitForTimeout(300);

  await expect(page.locator('.hidden-tray')).toBeVisible({ timeout: 3000 });
  const chip = page.locator('.tray-chip', { hasText: /Now Playing/ });
  await expect(chip).toBeVisible();

  // Click the chip to re-show "Now Playing".
  await chip.click();
  await page.waitForTimeout(500);

  // "Now Playing" must be back in the grid.
  await expect(page.locator('.grid-stack-item[gs-id="nowplaying"]')).toBeVisible({ timeout: 3000 });

  // Verify no two widgets overlap. This is the core bug fix assertion:
  // before the fix, "nowplaying" would re-appear at its saved (0,0) position, overlapping
  // "containers". After the fix, it is auto-placed into free space.
  const overlap = await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('.grid-stack-item')
    ) as (HTMLElement & { gridstackNode?: { x: number; y: number; w: number; h: number } })[];
    const rects = items
      .map((el) => el.gridstackNode)
      .filter((n): n is NonNullable<typeof n> => !!n && typeof n.x === 'number');
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const xOverlap = a.x < b.x + b.w && a.x + a.w > b.x;
        const yOverlap = a.y < b.y + b.h && a.y + a.h > b.y;
        if (xOverlap && yOverlap) return true;
      }
    }
    return false;
  });
  expect(overlap, 'two widgets overlap after show-from-tray (bug not fixed)').toBe(false);
});

/**
 * UI-driven hide: click a widget's hide button in edit mode → the widget is removed
 * from the grid AND the "Hidden widgets" tray appears with a chip for it → click the
 * chip → the widget returns to the grid without overlapping any other widget.
 *
 * This is the exact user-reported broken path (hide via the button, not the API).
 */
test('hide button removes widget and shows tray; chip restores it without overlap', async ({ page }) => {
  await setupAndLogin(page);

  // Ensure a connection so the grid renders.
  await page.goto('/settings');
  await expect(page.locator('.master-detail')).toBeVisible();
  if ((await page.locator('.conn-card').count()) === 0) {
    await page.locator('.md-rail-item', { hasText: 'Jellyfin' }).click();
    const detail = page.locator('.md-detail');
    await detail.locator('.add-btn').click();
    const form = detail.locator('.add-form');
    await form.locator('input[name=name]').fill('Hide JF');
    await form.locator('input[name=baseUrl]').fill('http://localhost:8096');
    await form.locator('input[name=secret]').fill('hide-key-123');
    await form.locator('button[formaction="?/create"]').click();
    await expect(form).not.toBeVisible({ timeout: 5000 });
  }

  await page.goto('/');
  await expect(page.locator('.dash-grid')).toBeVisible();
  await page.waitForTimeout(400);

  // Confirm the tray does NOT appear before we hide anything.
  await expect(page.locator('.hidden-tray')).toHaveCount(0);

  // Enter edit mode.
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await expect(page.locator('.dash-grid.is-editing')).toBeVisible();
  await page.waitForTimeout(300);

  // Still no tray — nothing hidden yet.
  await expect(page.locator('.hidden-tray')).toHaveCount(0);

  // Find the "Containers" widget and click its hide button.
  const containersItem = page.locator('.grid-stack-item[gs-id="containers"]');
  await expect(containersItem).toBeVisible();
  const hideBtn = containersItem.locator('button[title="Hide widget"]');
  await expect(hideBtn).toBeVisible();
  await hideBtn.click();
  await page.waitForTimeout(400);

  // The Containers widget must no longer be in the grid.
  await expect(page.locator('.grid-stack-item[gs-id="containers"]')).toHaveCount(0);

  // The "Hidden widgets" tray MUST be visible and contain a chip for Containers.
  const tray = page.locator('.hidden-tray');
  await expect(tray).toBeVisible({ timeout: 3000 });
  // The label must show the count "Hidden widgets (1)".
  await expect(tray.locator('.tray-label')).toContainText('Hidden widgets');
  await expect(tray.locator('.tray-label')).toContainText('1');

  const chip = tray.locator('.tray-chip', { hasText: /Containers/ });
  await expect(chip).toBeVisible();

  // Click the chip to restore Containers.
  await chip.click();
  await page.waitForTimeout(500);

  // Containers must be back in the grid.
  await expect(page.locator('.grid-stack-item[gs-id="containers"]')).toBeVisible({ timeout: 3000 });

  // Tray must now be gone (no more hidden widgets).
  await expect(page.locator('.hidden-tray')).toHaveCount(0);

  // Verify no two widgets overlap after the show-from-tray.
  const overlap = await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('.grid-stack-item')
    ) as (HTMLElement & { gridstackNode?: { x: number; y: number; w: number; h: number } })[];
    const rects = items
      .map((el) => el.gridstackNode)
      .filter((n): n is NonNullable<typeof n> => !!n && typeof n.x === 'number');
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const xOverlap = a.x < b.x + b.w && a.x + a.w > b.x;
        const yOverlap = a.y < b.y + b.h && a.y + a.h > b.y;
        if (xOverlap && yOverlap) return true;
      }
    }
    return false;
  });
  expect(overlap, 'two widgets overlap after show-from-tray (UI-hide path)').toBe(false);
});
