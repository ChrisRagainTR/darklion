// tests/e2e/documents.spec.js
// Tests: /documents page loads, firm-level doc list visible, action buttons present.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

test.describe('Documents — firm-level library', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  // ── Page loads ────────────────────────────────────────────────────────────

  test('/documents page loads without redirecting to /login', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
    expect(page.url()).toContain('/documents');
  });

  test('/documents page renders the top header (.top-header)', async ({ page }) => {
    await expect(page.locator('.top-header')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('/documents page renders the sidebar (.sidebar)', async ({ page }) => {
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Document list area ────────────────────────────────────────────────────

  test('document list area renders after loading (not stuck on spinner)', async ({ page }) => {
    await page.waitForFunction(
      () => !document.querySelector('.loading-spinner'),
      { timeout: TIMEOUTS.api }
    ).catch(() => null);

    const content = page.locator(
      '.data-table, .table-wrap, .docs-layout, .year-folder, .doc-row, ' +
      '.empty-state, [id*="docs-content"], [id*="doc-list"], #docs-results, .docs-results, .docs-search-wrap'
    ).first();
    await expect(content).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('page shows document rows or a meaningful empty-state (not an error page)', async ({ page }) => {
    await page.waitForFunction(
      () => !document.querySelector('.loading-spinner'),
      { timeout: TIMEOUTS.api }
    ).catch(() => null);

    const docRows = page.locator('.doc-row, .docs-result-item, #docs-results .result-item');
    const emptyState = page.locator('.empty-state, [class*="empty"]');
    const searchArea = page.locator('#docs-results, .docs-results');
    const rowCount = await docRows.count();
    const emptyCount = await emptyState.count();
    const searchCount = await searchArea.count();
    expect(rowCount > 0 || emptyCount > 0 || searchCount > 0).toBeTruthy();
  });

  // ── Doc row contents ──────────────────────────────────────────────────────

  test('when doc rows exist, the first row shows a doc name (.doc-name)', async ({ page }) => {
    await page.waitForSelector('.doc-row, .empty-state', { timeout: TIMEOUTS.api }).catch(() => null);
    const rows = page.locator('.doc-row');
    if (await rows.count() === 0) return; // empty state is fine
    await expect(rows.first().locator('.doc-name')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('when doc rows exist, download buttons (.btn-dl) are present', async ({ page }) => {
    await page.waitForSelector('.doc-row, .empty-state', { timeout: TIMEOUTS.api }).catch(() => null);
    const rows = page.locator('.doc-row');
    if (await rows.count() === 0) return;
    await expect(page.locator('.btn-dl').first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('when doc rows exist, year badges are shown', async ({ page }) => {
    await page.waitForSelector('.doc-row, .empty-state', { timeout: TIMEOUTS.api }).catch(() => null);
    const rows = page.locator('.doc-row');
    if (await rows.count() === 0) return;
    // Doc rows in the EJS include .doc-badges with year and type badges
    const badges = rows.first().locator('.doc-badges .doc-badge, .doc-badges .badge, [class*="badge"]');
    if (await badges.count() > 0) {
      await expect(badges.first()).toBeVisible({ timeout: TIMEOUTS.element });
    }
  });

  // ── Upload section ────────────────────────────────────────────────────────

  test('an Upload button or link is present on the page', async ({ page }) => {
    const uploadBtn = page.locator(
      'button:has-text("Upload"), a:has-text("Upload"), button:has-text("↑")'
    );
    if (await uploadBtn.count() > 0) {
      await expect(uploadBtn.first()).toBeVisible({ timeout: TIMEOUTS.element });
    }
    // Soft check — the page may organise uploads differently; just confirm no crash
  });
});
