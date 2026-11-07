// tests/e2e/my-work.spec.js
// Tests: My Work dashboard — sidebar entry, page renders, filter UI, API call.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

test.describe('My Work — page', () => {
  test('sidebar shows "My Work" link under Work group', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    await expect(page.locator('a.nav-item[href="/my-work"]')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('a.nav-item[href="/my-work"]')).toContainText('My Work');
  });

  test('clicking sidebar link navigates to /my-work', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    await page.locator('a.nav-item[href="/my-work"]').click();
    await page.waitForURL('**/my-work', { timeout: TIMEOUTS.navigation });
    await expect(page.locator('h1').filter({ hasText: 'My Work' })).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('filter selects render with expected options', async ({ page }) => {
    await page.goto(`${BASE_URL}/my-work`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    await expect(page.locator('#mw-f-source')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('#mw-f-priority')).toBeVisible();
    await expect(page.locator('#mw-f-due')).toBeVisible();
    await expect(page.locator('#mw-f-entity')).toBeVisible();
    // Source filter has the three expected options
    await expect(page.locator('#mw-f-source option')).toHaveCount(3);
  });

  test('content area resolves (table or empty state — never stuck on Loading)', async ({ page }) => {
    await page.goto(`${BASE_URL}/my-work`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    await page.waitForFunction(
      () => {
        const c = document.getElementById('mw-content');
        if (!c) return false;
        return c.querySelector('table') !== null || c.classList.contains('mw-empty');
      },
      { timeout: TIMEOUTS.api }
    );
  });

  test('GET /api/my-work responds 200 with items + counts shape', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const resp = await page.evaluate(async () => {
      const token = localStorage.getItem('dl_token');
      const r = await fetch('/api/my-work', { headers: { 'Authorization': 'Bearer ' + token } });
      return { ok: r.ok, status: r.status, body: await r.json() };
    });
    expect(resp.ok).toBe(true);
    expect(resp.body).toHaveProperty('items');
    expect(Array.isArray(resp.body.items)).toBe(true);
    expect(resp.body).toHaveProperty('counts');
    expect(resp.body.counts).toHaveProperty('total');
    expect(resp.body.counts).toHaveProperty('overdue');
  });
});
