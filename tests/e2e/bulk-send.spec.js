// tests/e2e/bulk-send.spec.js
// Tests: Bulk Send page loads, audience builder renders, compose section present.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

test.describe('Bulk Send', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/bulk-send`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  test('bulk-send page loads without redirecting to /login', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
  });

  test('page shows "Bulk Send" heading', async ({ page }) => {
    const heading = page.locator('h1, .page-top h1');
    await expect(heading).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(heading).toContainText(/bulk.?send/i);
  });

  test('top header and sidebar render', async ({ page }) => {
    await expect(page.locator('.top-header, header')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.sidebar, nav.sidebar')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('audience builder section is visible', async ({ page }) => {
    const audience = page.locator('#audience-builder, .audience-builder, [data-section="audience"], .audience-section');
    // If not a dedicated section, check for "audience" text or filter button
    const hasSection = await audience.count() > 0;
    if (!hasSection) {
      const filterBtn = page.locator('button:has-text("Add Filter"), button:has-text("filter"), .btn:has-text("Audience")');
      await expect(filterBtn.first()).toBeVisible({ timeout: TIMEOUTS.element });
    } else {
      await expect(audience.first()).toBeVisible({ timeout: TIMEOUTS.element });
    }
  });

  test('compose / message area is present on page', async ({ page }) => {
    const compose = page.locator('#compose, .compose, textarea[placeholder*="message" i], textarea[placeholder*="write" i], #msg-body, .msg-body');
    // May not be visible until audience is built — just check it exists
    const hasCompose = await compose.count() > 0;
    if (hasCompose) {
      await expect(compose.first()).toBeAttached();
    } else {
      // Fallback: check that a subject input exists somewhere on the page
      const subjectInput = page.locator('input[placeholder*="subject" i], #subject, #bulk-subject');
      const hasSubject = await subjectInput.count() > 0;
      // Either compose or subject should be on the page
      expect(hasCompose || hasSubject).toBeTruthy();
    }
  });

  test('"Send", "Preview", or "Continue" button exists in the workflow', async ({ page }) => {
    // Bulk send is multi-step — the final Send button may be hidden until steps are complete
    // Just verify it exists in the DOM (attached), not necessarily visible
    const btn = page.locator('button:has-text("Send"), button:has-text("Preview"), button:has-text("Continue"), .btn-gold');
    await expect(btn.first()).toBeAttached({ timeout: TIMEOUTS.api });
  });

});
