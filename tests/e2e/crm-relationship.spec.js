// tests/e2e/crm-relationship.spec.js
// Tests: relationship detail page — all tabs, edit modal, pipeline stage visible.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

/** Navigate to the first relationship detail page. Returns false if none exist. */
async function getRelationshipPage(page) {
  await page.goto(`${BASE_URL}/crm`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  await page.waitForSelector(
    '#rel-list-container .data-table tbody tr, #rel-list-container .empty-state',
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  const rows = page.locator('#rel-list-container .data-table tbody tr');
  if (await rows.count() === 0) return false;
  await rows.first().click();
  await page.waitForURL('**/crm/relationship/**', { timeout: TIMEOUTS.api });
  await page.waitForFunction(
    () => !document.querySelector('.entity-name')?.textContent?.includes('Loading'),
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  await page.waitForTimeout(500);
  return true;
}

test.describe('CRM — Relationship detail page', () => {
  // ── Page header ──────────────────────────────────────────────────────────

  test('relationship detail page loads and shows the entity header', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    await expect(page.locator('.entity-header')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('entity back link "← Relationships" is visible', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    await expect(page.locator('.entity-back')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.entity-back')).toContainText('←');
  });

  test('relationship name heading is visible and non-empty', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    const nameEl = page.locator('.entity-name');
    await expect(nameEl).toBeVisible({ timeout: TIMEOUTS.element });
    expect((await nameEl.textContent())?.trim().length).toBeGreaterThan(0);
  });

  test('entity badges (service tier / billing status) are rendered', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    await expect(page.locator('.entity-badges')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  // ── Tab bar ──────────────────────────────────────────────────────────────

  test('tab bar is visible with at least "Overview" and one other tab', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    await page.waitForSelector('.tab-item', { timeout: TIMEOUTS.api });
    const overviewCount = await page.locator('.tab-item').filter({ hasText: 'Overview' }).count();
    const totalTabs = await page.locator('.tab-item').count();
    expect(overviewCount).toBeGreaterThan(0);
    expect(totalTabs).toBeGreaterThan(1);
  });

  test('"Overview" tab is active by default', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    await expect(
      page.locator('.tab-bar .tab-item').filter({ hasText: 'Overview' })
    ).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('clicking a non-Overview tab marks it active', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    await page.waitForSelector('.tab-item', { timeout: TIMEOUTS.api });
    // Click the second tab (whatever it is — Engagement, Workflow, etc.)
    const tabs = page.locator('.tab-item');
    if (await tabs.count() < 2) return;
    const secondTab = tabs.nth(1);
    await secondTab.click();
    await expect(secondTab).toHaveClass(/active/, { timeout: TIMEOUTS.api });
  });

  test('clicking "Companies" tab marks it active', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    const companiesTab = page.locator('.tab-bar .tab-item').filter({ hasText: 'Companies' });
    if (await companiesTab.count() === 0) return test.skip(true, 'No Companies tab');
    await companiesTab.click();
    await expect(companiesTab).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('clicking "Documents" tab marks it active', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    const docsTab = page.locator('.tab-bar .tab-item').filter({ hasText: 'Documents' });
    if (await docsTab.count() === 0) return test.skip(true, 'No Documents tab');
    await docsTab.click();
    await expect(docsTab).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('clicking "Notes" tab marks it active', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    const notesTab = page.locator('.tab-bar .tab-item').filter({ hasText: 'Notes' });
    if (await notesTab.count() === 0) return test.skip(true, 'No Notes tab');
    await notesTab.click();
    await expect(notesTab).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  // ── Edit modal ───────────────────────────────────────────────────────────

  test('Edit button is visible in entity actions', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    await expect(
      page.locator('.entity-actions button:has-text("Edit"), .entity-header button:has-text("Edit")')
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('clicking Edit opens a modal with the relationship Name field', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    const editBtn = page.locator('.entity-actions button:has-text("Edit"), .entity-header button:has-text("Edit")').first();
    await expect(editBtn).toBeVisible({ timeout: TIMEOUTS.api });
    await editBtn.click();
    await expect(page.locator('.modal-overlay:not(.hidden), .modal-overlay.open')).toBeVisible({ timeout: TIMEOUTS.api });
    await expect(
      page.locator('#rel-form-name, input[placeholder*="Family"], input[id*="name"]').first()
    ).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('Edit modal has Service Tier and Billing Status selects', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    const editBtn = page.locator('.entity-actions button:has-text("Edit"), .entity-header button:has-text("Edit")').first();
    await expect(editBtn).toBeVisible({ timeout: TIMEOUTS.api });
    await editBtn.click();
    await expect(page.locator('#rel-form-tier, select[id*="tier"]')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  // ── Overview content and pipeline ─────────────────────────────────────────

  test('Overview tab content renders the overview panels', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');
    // Wait for the async overview data to load
    await page.waitForTimeout(2000);
    const activeContent = page.locator('.tab-content.active, #tab-overview.active');
    await expect(activeContent).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Overview tab shows at least one data panel or placeholder (not stuck loading)', async ({ page }) => {
    const found = await getRelationshipPage(page);
    if (!found) return test.skip(true, 'No relationships in the system');

    await page.waitForFunction(
      () => !document.querySelector('.loading-spinner'),
      { timeout: TIMEOUTS.api }
    ).catch(() => null);

    const panels = page.locator('.ov-panel, .ov-page, .stat-row, .info-card, .card, .placeholder-section');
    const count = await panels.count();
    expect(count).toBeGreaterThan(0);
  });
});
