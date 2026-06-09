import { test, expect, type Page } from '@playwright/test';

// The agent's LLM is mocked at the provider boundary via PULSE_AGENT_FAKE=1 (set in
// playwright.config.ts webServer env). The fake driver runs the REAL read tools and the
// REAL confirm → executeConfirmed → resolveAction/docker → audit path; only token
// generation is scripted, so these flows are deterministic and hermetic.

async function setupAndLogin(page: Page) {
  await page.goto('/');
  // First run redirects to /setup; create the admin then we land on '/'.
  if (page.url().includes('/setup')) {
    await page.fill('input[name=email]', 'a@b.com');
    await page.fill('input[name=password]', 'password123');
    await page.click('button');
    await page.waitForURL((u) => !u.pathname.includes('/setup'), { timeout: 5000 });
  }
  // Subsequent runs (same DB) redirect to /login.
  if (page.url().includes('/login')) {
    await page.fill('input[name=email]', 'a@b.com');
    await page.fill('input[name=password]', 'password123');
    await page.click('button');
    await expect(page).toHaveURL('/');
  }
}

// Save an AI config (validation skipped) so getModel() is non-null for the read path.
// The connections-based backend needs a connection first, then admin refs pointing at it.
async function configureAi(page: Page): Promise<number> {
  const connRes = await page.request.post('/api/ai/connections', {
    data: { label: 'Test', provider: 'openai', apiKey: 'k', validate: false }
  });
  expect(connRes.ok()).toBeTruthy();
  const { id } = await connRes.json();
  const res = await page.request.post('/api/ai/config', {
    data: { adminConnectionId: id, adminModel: 'gpt-4o-mini', validate: false }
  });
  expect(res.ok()).toBeTruthy();
  return id;
}

test('agent endpoints require auth', async ({ page }) => {
  await setupAndLogin(page);
  const ctx = await page.context().browser()!.newContext();
  try {
    expect((await ctx.request.post('/api/agent/chat', { data: { message: 'hi' } })).status()).toBe(401);
    expect((await ctx.request.get('/api/events')).status()).toBe(401);
    expect((await ctx.request.get('/api/agent/audit')).status()).toBe(401);
  } finally {
    await ctx.close();
  }
});

test('AI config saves and reports configured', async ({ page }) => {
  await setupAndLogin(page);
  const id = await configureAi(page);
  const cfg = await page.request.get('/api/ai/config').then((r) => r.json());
  expect(cfg.adminConnectionId).toBe(id);
  expect(cfg.adminModel).toBe('gpt-4o-mini');
});

test('read query: a read tool streams an inline result + assistant answer', async ({ page }) => {
  await setupAndLogin(page);
  await configureAi(page);
  await page.goto('/');
  await page.click('.agent-fab');
  await page.fill('.agent-input textarea', 'what is in the download queue?');
  await page.click('.agent-input button');
  // The fake driver runs a real read tool → a compact (collapsed) tool-activity
  // indicator renders, showing the tool name(s) used this turn.
  await expect(page.locator('.tool-activity').first()).toBeVisible({ timeout: 8000 });
  // It's collapsed by default; expanding reveals the args/result detail.
  await page.locator('.tool-activity-row').first().click();
  await expect(page.locator('.tool-activity-detail').first()).toBeVisible();
  // …and the assistant streams a textual answer (now rendered as Markdown).
  await expect(page.locator('.agent-msg.assistant .md')).toBeVisible({ timeout: 8000 });
});

test('write query: confirmation card → confirm → action runs + resumes + audit entry', async ({ page }) => {
  await setupAndLogin(page);
  await configureAi(page);
  await page.goto('/');
  await page.click('.agent-fab');
  await page.fill('.agent-input textarea', 'restart jellyfin');
  await page.click('.agent-input button');
  // A write tool pauses for confirmation — the confirm card appears (the ONLY write path).
  await expect(page.locator('.agent-card.confirm')).toBeVisible({ timeout: 8000 });
  await page.click('.agent-card.confirm .btn-p'); // Confirm
  // The resumed stream shows the tool activity (the executed write) as a compact indicator.
  await expect(page.locator('.tool-activity').first()).toBeVisible({ timeout: 8000 });
  // The executed (or gracefully-failed) write lands in the audit log.
  await expect
    .poll(
      async () => {
        const audit = await page.request.get('/api/agent/audit').then((r) => r.json());
        return audit.actions.length as number;
      },
      { timeout: 8000 }
    )
    .toBeGreaterThan(0);
});

test('events bell renders and opens the feed', async ({ page }) => {
  await setupAndLogin(page);
  await page.goto('/');
  await expect(page.locator('.bell-btn')).toBeVisible();
  await page.click('.bell-btn');
  await expect(page.locator('.bell-feed')).toBeVisible();
});
