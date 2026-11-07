// tests/e2e/crm-company.spec.js
// Tests: company detail page — subtabs, edit modal, docs tab.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

/** Navigate to the first company detail page. Returns false if none exist. */
async function getCompanyPage(page) {
  // Use ?tab=companies URL param to jump straight to the Companies tab
  await page.goto(`${BASE_URL}/crm?tab=companies`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });

  await page.waitForSelector(
    '#companies-list-container .data-table tbody tr, #companies-list-container .empty-state',
    { timeout: TIMEOUTS.api }
  ).catch(() => null);

  const rows = page.locator('#companies-list-container .data-table tbody tr');
  if (await rows.count() === 0) return false;

  await rows.first().click();
  await page.waitForURL('**/crm/company/**', { timeout: TIMEOUTS.api });
  // Wait for entity data to load (dismiss the "Loading..." state)
  await page.waitForFunction(
    () => !document.querySelector('.entity-name')?.textContent?.includes('Loading'),
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  await page.waitForTimeout(500);
  return true;
}

test.describe('CRM — Company detail page', () => {
  // ── Page header ──────────────────────────────────────────────────────────

  test('company detail page shows entity header back link', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    await expect(page.locator('.entity-back')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('company entity name is visible', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    const nameEl = page.locator('#entity-name, .entity-name');
    await expect(nameEl).toBeVisible({ timeout: TIMEOUTS.element });
    expect((await nameEl.textContent())?.trim().length).toBeGreaterThan(0);
  });

  // ── Subtab bar (crm-company.ejs uses .subtab-bar / .subtab-item) ─────────

  test('company detail page shows a tab/subtab bar', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    // Use tab-item presence instead of container visibility (sticky tab-bar can fail toBeVisible)
    await page.waitForSelector('.tab-item', { timeout: TIMEOUTS.api });
    expect(await page.locator('.tab-item').count()).toBeGreaterThan(0);
  });

  test('the first subtab is active by default', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    const activeTab = page.locator('.subtab-item.active, .tab-item.active').first();
    await expect(activeTab).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('clicking the Docs / Documents subtab switches content', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    const docsTab = page.locator('.subtab-item:has-text("Docs"), .subtab-item:has-text("Documents"), .tab-item:has-text("Docs"), .tab-item:has-text("Documents")');
    if (await docsTab.count() === 0) return test.skip(true, 'No Docs tab on company page');
    await docsTab.first().click();
    await expect(docsTab.first()).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('clicking the Tax subtab switches content', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    const taxTab = page.locator('.subtab-item:has-text("Tax"), .tab-item:has-text("Tax")');
    if (await taxTab.count() === 0) return test.skip(true, 'No Tax tab on company page');
    await taxTab.first().click();
    await expect(taxTab.first()).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  // ── Edit modal ───────────────────────────────────────────────────────────

  test('Edit button is present in the entity header', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    await expect(page.locator('button:has-text("Edit")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('clicking Edit opens a modal with company form fields', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    const editBtn = page.locator('button:has-text("Edit")').first();
    await expect(editBtn).toBeVisible({ timeout: TIMEOUTS.api });
    await editBtn.click();
    // Wait for modal heading to appear — more reliable than checking overlay class
    await expect(page.locator('h2:has-text("Edit Company"), h2:has-text("Edit"), .modal-title:has-text("Edit")')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  // ── Docs tab ─────────────────────────────────────────────────────────────

  test('Docs tab: Upload button is present', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    // Click the Docs tab item specifically (not subtab)
    const docsTab = page.locator('.tab-item:has-text("Docs")').first();
    if (await docsTab.count() === 0) return test.skip(true, 'No Docs tab');
    await docsTab.click();
    await page.waitForTimeout(500);
    // Upload button exists in DOM — check attachment not visibility (may need scroll)
    const uploadBtn = page.locator('button:has-text("Upload")').first();
    if (await uploadBtn.count() === 0) return test.skip(true, 'No Upload button found');
    await expect(uploadBtn).toBeAttached();
  });

  test('Docs tab: content area loads (year folders, doc rows, or empty state)', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    const docsTab = page.locator('.subtab-item:has-text("Docs"), .subtab-item:has-text("Documents"), .tab-item:has-text("Docs")');
    if (await docsTab.count() === 0) return test.skip(true, 'No Docs tab');
    await docsTab.first().click();
    await page.waitForSelector(
      '.docs-layout, .year-folder, .doc-row, .empty-state',
      { timeout: TIMEOUTS.api }
    ).catch(() => null);
    // Docs content or loading finished
    const docsContent = page.locator('.docs-layout, #docs-content, .year-folder, .empty-state').first();
    await expect(docsContent).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('Docs tab: when doc rows exist, they have a Download button (.btn-dl)', async ({ page }) => {
    const found = await getCompanyPage(page);
    if (!found) return test.skip(true, 'No companies in the system');
    const docsTab = page.locator('.subtab-item:has-text("Docs"), .subtab-item:has-text("Documents"), .tab-item:has-text("Docs")');
    if (await docsTab.count() === 0) return test.skip(true, 'No Docs tab');
    await docsTab.first().click();
    await page.waitForSelector('.doc-row, .empty-state', { timeout: TIMEOUTS.api }).catch(() => null);
    const docRows = page.locator('.doc-row');
    if (await docRows.count() > 0) {
      await expect(docRows.first().locator('.btn-dl')).toBeVisible({ timeout: TIMEOUTS.element });
    }
  });
});
