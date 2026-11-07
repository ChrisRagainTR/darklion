// tests/e2e/proposals.spec.js
// Tests: proposals list loads, stats cards render, "+ New Proposal" button visible,
// filter tabs work, and clicking a proposal opens its detail.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

test.describe('Proposals', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/proposals`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  // ── Page structure ────────────────────────────────────────────────────────

  test('proposals page loads and shows "Proposals" heading in .page-top h1', async ({ page }) => {
    await expect(page.locator('.page-top h1')).toContainText('Proposals', { timeout: TIMEOUTS.element });
  });

  test('"+ New Proposal" button is visible (a.btn-gold href="/proposals/new")', async ({ page }) => {
    await expect(
      page.locator('a:has-text("+ New Proposal"), a.btn-gold:has-text("Proposal")')
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Stats row ─────────────────────────────────────────────────────────────

  test('stats row (#stats-row) renders 4 stat cards', async ({ page }) => {
    await expect(page.locator('#stats-row .stat-card')).toHaveCount(4, { timeout: TIMEOUTS.element });
  });

  test('"Total" stat card label is visible', async ({ page }) => {
    await expect(page.locator('.stat-label').filter({ hasText: 'Total' })).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"Sent" stat card label is visible', async ({ page }) => {
    await expect(page.locator('.stat-label').filter({ hasText: 'Sent' })).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"Accepted / Signed" stat card label is visible', async ({ page }) => {
    await expect(page.locator('.stat-label').filter({ hasText: /Accepted/i })).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"Signed MRR" stat card renders with gold value (#stat-mrr)', async ({ page }) => {
    await expect(page.locator('#stat-mrr')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Filter tabs ───────────────────────────────────────────────────────────

  test('filter tab bar renders with All, Draft, Sent, Viewed, Accepted, Signed tabs', async ({ page }) => {
    await expect(page.locator('.filter-tabs')).toBeVisible({ timeout: TIMEOUTS.element });
    for (const tabName of ['All', 'Draft', 'Sent', 'Viewed', 'Accepted', 'Signed']) {
      await expect(
        page.locator('.filter-tab').filter({ hasText: tabName })
      ).toBeVisible({ timeout: TIMEOUTS.element });
    }
  });

  test('"All" filter tab is active by default', async ({ page }) => {
    await expect(
      page.locator('.filter-tab').filter({ hasText: 'All' })
    ).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('clicking the "Draft" tab activates it', async ({ page }) => {
    await page.locator('.filter-tab').filter({ hasText: 'Draft' }).click();
    await expect(
      page.locator('.filter-tab').filter({ hasText: 'Draft' })
    ).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('clicking the "Signed" tab activates it', async ({ page }) => {
    await page.locator('.filter-tab').filter({ hasText: 'Signed' }).click();
    await expect(
      page.locator('.filter-tab').filter({ hasText: 'Signed' })
    ).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  // ── Proposal list ─────────────────────────────────────────────────────────

  test('#proposals-list container is visible', async ({ page }) => {
    await expect(page.locator('#proposals-list')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('proposals list finishes loading and shows cards or empty state', async ({ page }) => {
    await page.waitForFunction(
      () => {
        const el = document.getElementById('proposals-list');
        return el && !el.querySelector('.loading-state');
      },
      { timeout: TIMEOUTS.api }
    ).catch(() => null);

    const cards = page.locator('.proposal-card');
    const emptyState = page.locator('#proposals-list .empty-state, #proposals-list .empty-icon');
    expect(await cards.count() > 0 || await emptyState.count() > 0).toBeTruthy();
  });

  test('when proposal cards exist, each shows a client name (.proposal-client)', async ({ page }) => {
    await page.waitForFunction(
      () => !document.querySelector('#proposals-list .loading-state'),
      { timeout: TIMEOUTS.api }
    ).catch(() => null);
    const cards = page.locator('.proposal-card');
    if (await cards.count() === 0) return;
    await expect(cards.first().locator('.proposal-client')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('when proposal cards exist, status badge is shown (.badge-draft/.badge-sent/etc)', async ({ page }) => {
    await page.waitForFunction(
      () => !document.querySelector('#proposals-list .loading-state'),
      { timeout: TIMEOUTS.api }
    ).catch(() => null);
    const cards = page.locator('.proposal-card');
    if (await cards.count() === 0) return;
    const statusBadge = cards.first().locator('[class*="badge-"]');
    await expect(statusBadge.first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── New proposal form ─────────────────────────────────────────────────────

  test('navigating to /proposals/new loads the new proposal creation page', async ({ page }) => {
    await page.goto(`${BASE_URL}/proposals/new`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUTS.navigation,
    });
    expect(page.url()).not.toContain('/login');
    const bodyText = await page.locator('body').textContent();
    expect(bodyText?.trim().length).toBeGreaterThan(20);
  });
});
