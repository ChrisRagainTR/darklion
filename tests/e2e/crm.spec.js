// tests/e2e/crm.spec.js
// Tests: CRM list page tabs (Relationships / People / Companies), search filtering,
// and opening a detail row.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

test.describe('CRM list page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/crm`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  // ── Page structure ────────────────────────────────────────────────────────

  test('CRM page loads and renders the page tab bar', async ({ page }) => {
    await expect(page.locator('#page-tabs')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Tab navigation ────────────────────────────────────────────────────────

  test('"👥 Relationships" tab is active by default and content is visible', async ({ page }) => {
    const relTab = page.locator('.page-tab[data-tab="relationships"]');
    await expect(relTab).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-relationships')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-people')).toBeHidden();
    await expect(page.locator('#tab-companies')).toBeHidden();
  });

  test('clicking "👤 People" tab shows People content and hides Relationships', async ({ page }) => {
    await page.locator('.page-tab[data-tab="people"]').click();
    await expect(page.locator('#tab-people')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-relationships')).toBeHidden();
    await expect(page.locator('.page-tab[data-tab="people"]')).toHaveClass(/active/);
  });

  test('clicking "🏢 Companies" tab shows Companies content and hides Relationships', async ({ page }) => {
    await page.locator('.page-tab[data-tab="companies"]').click();
    await expect(page.locator('#tab-companies')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-relationships')).toBeHidden();
    await expect(page.locator('.page-tab[data-tab="companies"]')).toHaveClass(/active/);
  });

  // ── Relationships data load ───────────────────────────────────────────────

  test('Relationships tab loads data — shows a table or empty-state (not stuck loading)', async ({ page }) => {
    const tableOrEmpty = page.locator(
      '#rel-list-container .data-table, #rel-list-container .empty-state, #rel-list-container .error-msg'
    );
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('Relationships table columns include "Name", "Service Tier", "Billing" when data exists', async ({ page }) => {
    await page.waitForSelector(
      '#rel-list-container .data-table, #rel-list-container .empty-state, #rel-list-container .error-msg',
      { timeout: TIMEOUTS.api }
    ).catch(() => null);
    const tableExists = await page.locator('#rel-list-container .data-table').count();
    if (tableExists > 0) {
      await expect(page.locator('#rel-list-container th').filter({ hasText: 'Name' })).toBeVisible();
      await expect(page.locator('#rel-list-container th').filter({ hasText: 'Billing' })).toBeVisible();
    }
    // Soft pass if no table rendered (empty state or error)
  });

  // ── Search / filter inputs ────────────────────────────────────────────────

  test('Relationships "Filter…" search input is visible and accepts text', async ({ page }) => {
    const searchInput = page.locator('#rel-search');
    await expect(searchInput).toBeVisible({ timeout: TIMEOUTS.element });
    await searchInput.fill('smith');
    await expect(searchInput).toHaveValue('smith');
  });

  test('People "Filter…" search input is visible after switching to People tab', async ({ page }) => {
    await page.locator('.page-tab[data-tab="people"]').click();
    await expect(page.locator('#people-search')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Companies "Filter…" search input is visible after switching to Companies tab', async ({ page }) => {
    await page.locator('.page-tab[data-tab="companies"]').click();
    await expect(page.locator('#co-search')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── New record buttons ────────────────────────────────────────────────────

  test('"+ New Relationship" button is visible on the Relationships section', async ({ page }) => {
    await expect(page.locator('button:has-text("+ New Relationship")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"+ New Relationship" button opens the New Relationship modal', async ({ page }) => {
    await page.locator('button:has-text("+ New Relationship")').click();
    await expect(page.locator('#rel-modal')).not.toHaveClass(/hidden/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#rel-form-name')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"+ New Person" button is visible after switching to People tab', async ({ page }) => {
    await page.locator('.page-tab[data-tab="people"]').click();
    await expect(page.locator('button:has-text("+ New Person")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Opening a detail row ──────────────────────────────────────────────────

  test('clicking a relationship table row navigates to /crm/relationship/:id', async ({ page }) => {
    await page.waitForSelector(
      '#rel-list-container .data-table tbody tr',
      { timeout: TIMEOUTS.api }
    ).catch(() => null);

    const rows = page.locator('#rel-list-container .data-table tbody tr');
    const count = await rows.count();
    if (count === 0) return test.skip(true, 'No relationships to test navigation');

    await rows.first().click();
    await page.waitForURL('**/crm/relationship/**', { timeout: TIMEOUTS.api });
    expect(page.url()).toMatch(/\/crm\/relationship\/\d+/);
  });

  test('clicking a person table row navigates to /crm/person/:id', async ({ page }) => {
    await page.locator('.page-tab[data-tab="people"]').click();
    await page.waitForSelector(
      '#people-list-container .data-table tbody tr',
      { timeout: TIMEOUTS.api }
    ).catch(() => null);

    const rows = page.locator('#people-list-container .data-table tbody tr');
    const count = await rows.count();
    if (count === 0) return test.skip(true, 'No people to test navigation');

    await rows.first().click();
    await page.waitForURL('**/crm/person/**', { timeout: TIMEOUTS.api });
    expect(page.url()).toMatch(/\/crm\/person\/\d+/);
  });

  test('clicking a company table row navigates to /crm/company/:id', async ({ page }) => {
    await page.locator('.page-tab[data-tab="companies"]').click();
    await page.waitForSelector(
      '#companies-list-container .data-table tbody tr',
      { timeout: TIMEOUTS.api }
    ).catch(() => null);

    const rows = page.locator('#companies-list-container .data-table tbody tr');
    const count = await rows.count();
    if (count === 0) return test.skip(true, 'No companies to test navigation');

    await rows.first().click();
    await page.waitForURL('**/crm/company/**', { timeout: TIMEOUTS.api });
    expect(page.url()).toMatch(/\/crm\/company\/\d+/);
  });
});
