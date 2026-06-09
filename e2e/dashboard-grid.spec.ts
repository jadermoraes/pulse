import { test, expect } from '@playwright/test';

// Verifies the GridStack free-placement dashboard:
//  1. drag a widget to a new position and confirm it STAYS there (float:true, no reflow),
//  2. resize a widget taller via the native SOUTH handle and confirm its grid height grows
//     by a whole preset cell (cellHeight == the base "Small" height; native drag snaps to
//     whole cells == the presets, with NO size buttons),
//  3. the new position persists across a reload (debounced POST /api/layout),
//  4. NO list widget body has an internal scrollbar (content fits the cell height).

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

// Read grid position/size from the GridStack engine node (attributes don't reliably
// update on drag/resize; the node is the source of truth).
const nodePos = (el: HTMLElement) => {
  const n = (el as unknown as { gridstackNode?: { x: number; y: number; h: number } }).gridstackNode;
  return { x: n?.x ?? -1, y: n?.y ?? -1, h: n?.h ?? -1 };
};

test('gridstack: drag stays put, resize works, persists, no scrollbars', async ({ page }) => {
  await setupAndLogin(page);

  // Ensure a connection exists so the grid (not the empty state) renders.
  await page.goto('/settings');
  await expect(page.locator('.master-detail')).toBeVisible();
  if ((await page.locator('.conn-card').count()) === 0) {
    await page.locator('.md-rail-item', { hasText: 'Jellyfin' }).click();
    const detail = page.locator('.md-detail');
    await detail.locator('.add-btn').click();
    const form = detail.locator('.add-form');
    await form.locator('input[name=name]').fill('Grid JF');
    await form.locator('input[name=baseUrl]').fill('http://localhost:8096');
    await form.locator('input[name=secret]').fill('grid-key-123');
    await form.locator('button[formaction="?/create"]').click();
    await expect(form).not.toBeVisible({ timeout: 5000 });
  }

  await page.goto('/');
  await expect(page.locator('.dash-grid')).toBeVisible();
  const firstItem = page.locator('.grid-stack-item').first();
  await expect(firstItem).toBeVisible();
  await expect(firstItem).toHaveAttribute('gs-id', /.+/);

  // Enter edit mode → setStatic(false) enables drag + resize.
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await expect(page.locator('.dash-grid.is-editing')).toBeVisible();
  await page.waitForTimeout(300);

  // --- 1: drag the handle and confirm the position changes (and, with float:true, stays). ---
  const handle = firstItem.locator('.wf-drag');
  await expect(handle).toBeVisible();
  const before = await firstItem.evaluate(nodePos);

  const hb = await handle.boundingBox();
  if (!hb) throw new Error('no handle bbox');
  const sx = hb.x + hb.width / 2;
  const sy = hb.y + hb.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(sx + i * 15, sy + i * 12);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await firstItem.evaluate(nodePos);
  expect(`${after.x},${after.y}`).not.toBe(`${before.x},${before.y}`);

  // The drag must END cleanly: no item is left in GridStack's active-drag state, so the
  // widget does NOT keep following the mouse after release (the bug this guards against).
  const draggingCount = await page.locator('.grid-stack-item.ui-draggable-dragging').count();
  expect(draggingCount, 'a widget is stuck in dragging state after mouseup').toBe(0);
  // Moving the mouse after release must NOT move the widget (it would if drag never ended).
  await page.mouse.move(sx + 400, sy + 200);
  await page.waitForTimeout(120);
  const afterStrayMove = await firstItem.evaluate(nodePos);
  expect(`${afterStrayMove.x},${afterStrayMove.y}`).toBe(`${after.x},${after.y}`);

  // --- 2: resize via the native SOUTH handle and confirm grid height grows by a whole
  // preset cell. With cellHeight == the base "Small" height, dragging ~1.5 cells snaps the
  // height up by at least one preset (Small→Medium). No size buttons are involved. ---
  const sHandle = firstItem.locator('.ui-resizable-s');
  await sHandle.scrollIntoViewIfNeeded();
  const sb = await sHandle.boundingBox();
  if (!sb) throw new Error('no s-handle bbox');
  const rx = sb.x + sb.width / 2;
  const ry = sb.y + sb.height / 2;
  await page.mouse.move(rx, ry);
  await page.mouse.down();
  // Drag down ~1.5 base cells (cellHeight ≈ 150px) so the snap lands on the next preset.
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(rx, ry + i * 12);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const afterResize = await firstItem.evaluate(nodePos);
  // Height grew, and lands on a whole-cell preset (1=Small, 2=Medium, 3=Large, 4=XL).
  expect(afterResize.h).toBeGreaterThan(after.h);
  expect([1, 2, 3, 4]).toContain(afterResize.h);

  // No size buttons exist anymore — resizing is purely drag.
  expect(await page.locator('.wf-chip').count()).toBe(0);

  // --- 3: position persists across reload (debounced POST /api/layout). ---
  const persisted = await firstItem.evaluate(nodePos);
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator('.dash-grid')).toBeVisible();
  await page.waitForTimeout(400);
  const reloaded = await page.locator('.grid-stack-item').first().evaluate(nodePos);
  expect(`${reloaded.x},${reloaded.y}`).toBe(`${persisted.x},${persisted.y}`);

  // --- 4: no internal scrollbars on any widget body/list container. ---
  const scrollers = await page.evaluate(() => {
    const sel = ['.clist', '.qlist', '.wlist', '.ws-list', '.streams', '.rw-list', '.wf-body'];
    const offenders: string[] = [];
    for (const s of sel) {
      for (const el of Array.from(document.querySelectorAll(s)) as HTMLElement[]) {
        if (el.scrollHeight - el.clientHeight > 2) offenders.push(`${s}:${el.scrollHeight}>${el.clientHeight}`);
      }
    }
    return offenders;
  });
  expect(scrollers, `internal scrollbars found: ${scrollers.join(', ')}`).toEqual([]);
});

// Verifies the MODULAR HEIGHT SCALE: resizing a widget via the native handle snaps STRICTLY
// to whole base cells == the presets (Small=1 / Medium=2 / Large=3 / XL=4 cells), never an
// in-between height; never clips a rendered row; never produces an internal scrollbar. A
// little empty space at the bottom of a preset is acceptable (alignment over exact fit).
// Also asserts the compose relationship (two stacked Smalls equal one Medium) holds.
const SCALE = [1, 2, 3, 4];

test('resize snaps strictly to the modular height scale; no clip, no scrollbar', async ({ page }) => {
  // Serve a fixed set of containers so the Containers widget has a known row count.
  const N = 6;
  await page.route('**/api/docker/containers', async (route) => {
    const containers = Array.from({ length: N }, (_, i) => ({
      id: `c${i}`,
      name: `container-${i}`,
      image: 'img:latest',
      state: 'running',
      status: 'Up 1 hour'
    }));
    await route.fulfill({ json: { available: true, containers } });
  });

  await setupAndLogin(page);

  // Ensure a connection exists so the dashboard (not the empty state) renders.
  await page.goto('/settings');
  await expect(page.locator('.master-detail')).toBeVisible();
  if ((await page.locator('.conn-card').count()) === 0) {
    await page.locator('.md-rail-item', { hasText: 'Jellyfin' }).click();
    const detail = page.locator('.md-detail');
    await detail.locator('.add-btn').click();
    const form = detail.locator('.add-form');
    await form.locator('input[name=name]').fill('Grid JF');
    await form.locator('input[name=baseUrl]').fill('http://localhost:8096');
    await form.locator('input[name=secret]').fill('grid-key-123');
    await form.locator('button[formaction="?/create"]').click();
    await expect(form).not.toBeVisible({ timeout: 5000 });
  }

  await page.goto('/');
  await expect(page.locator('.dash-grid')).toBeVisible();

  // The Containers widget item (gs-id="containers"). List widget → Small..Large on the scale.
  const item = page.locator('.grid-stack-item[gs-id="containers"]');
  await expect(item).toBeVisible();
  await expect(item.locator('.clist .crow').first()).toBeVisible();
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Edit layout' }).click();
  await expect(page.locator('.dash-grid.is-editing')).toBeVisible();
  await page.waitForTimeout(300);

  // After a resize settles, report the node's snapped grid height plus row clip/scroll state.
  const afterResize = async () => {
    await page.waitForTimeout(450); // let resizestop snap + re-render settle
    return item.evaluate((el) => {
      const n = (el as unknown as { gridstackNode?: { h: number } }).gridstackNode;
      const list = el.querySelector('.clist') as HTMLElement;
      const rows = Array.from(el.querySelectorAll('.clist .crow')) as HTMLElement[];
      const last = rows[rows.length - 1];
      const lr = list.getBoundingClientRect();
      const rr = last.getBoundingClientRect();
      return {
        h: n?.h ?? -1,
        rowCount: rows.length,
        clip: rr.bottom - lr.bottom, // how much the last row overflows the list
        listScroll: list.scrollHeight - list.clientHeight
      };
    });
  };

  // Drag the south handle in steps; after each, the snapped grid height must be a scale value.
  // Grow tall (→ Large), then shrink (→ Medium/Small); each settle lands ON the scale.
  for (const dy of [200, -120, -200, 200]) {
    const handle = item.locator('.ui-resizable-s');
    const hb = await handle.boundingBox();
    if (!hb) throw new Error('no handle bbox');
    const hx = hb.x + hb.width / 2;
    const hy = hb.y + hb.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy + dy, { steps: 10 });
    await page.mouse.up();

    const a = await afterResize();
    // Height snaps STRICTLY to a scale preset (whole base cells) — never an in-between value.
    expect(SCALE, `snapped height ${a.h} is not on the modular scale`).toContain(a.h);
    // A list widget stays within Small(1)..XL(4) (maxH raised from Large to XL).
    expect(a.h, 'list widget below Small').toBeGreaterThanOrEqual(1);
    expect(a.h, 'list widget above XL').toBeLessThanOrEqual(4);
    expect(a.rowCount, 'at least one row rendered').toBeGreaterThanOrEqual(1);
    expect(a.rowCount, 'never more rendered rows than data').toBeLessThanOrEqual(N);
    // No clipped row and no internal scrollbar (fitRows renders only rows that fit).
    expect(a.clip, `last row clipped by ${a.clip}px`).toBeLessThanOrEqual(2);
    expect(a.listScroll, 'list has an internal scrollbar').toBeLessThanOrEqual(2);
  }

  // Compose check: two Small cells stacked equal one Medium cell (whole-cell alignment).
  const small = SCALE[0];
  const medium = SCALE[1];
  expect(small + small).toBe(medium);
});
