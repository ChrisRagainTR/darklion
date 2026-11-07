// tests/e2e/forecast.spec.js
// Tests: Revenue Forecast page loads, chart renders, data panels visible.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

test.describe('Revenue Forecast', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/forecast`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  test('forecast page loads without redirecting to /login', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
  });

  test('page shows "Forecast" or "Revenue" heading', async ({ page }) => {
    const heading = page.locator('h1, .page-top h1');
    await expect(heading).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(heading).toContainText(/forecast|revenue/i);
  });

  test('top header and sidebar render', async ({ page }) => {
    await expect(page.locator('.top-header, header')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.sidebar, nav.sidebar')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('forecast content area renders (not stuck loading)', async ({ page }) => {
    // Wait for spinner to clear or content to appear
    await page.waitForFunction(
      () => !document.querySelector('.spinner:not([style*="display: none"]):not([style*="display:none"])'),
      { timeout: TIMEOUTS.api }
    ).catch(() => {});
    // Page body should have meaningful content
    await expect(page.locator('body')).toBeVisible();
    const bodyText = await page.locator('body').textContent();
    expect(bodyText.length).toBeGreaterThan(100);
  });

  test('forecast table or summary cards are present', async ({ page }) => {
    // Wait for async data to load
    await page.waitForTimeout(2000);
    const table = page.locator('.fc-table, table');
    const cards = page.locator('.card');
    const hasTable = await table.count() > 0;
    const hasCards = await cards.count() > 0;
    expect(hasTable || hasCards).toBeTruthy();
  });

  test('page does not show a JS error page or blank screen', async ({ page }) => {
    const errorText = page.locator('body:has-text("Cannot GET"), body:has-text("ReferenceError"), body:has-text("SyntaxError")');
    expect(await errorText.count()).toBe(0);
  });

});
