// tests/e2e/crm-person.spec.js
// Tests: person detail page — all tabs (Overview/Docs/Tax/Communication/Notes),
// Edit modal, Docs tab (upload area, file drop, doc rows with Download button),
// portal panel on Overview.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

/** Navigate to the first available person detail page. Returns false if none exist. */
async function getPersonPage(page) {
  await page.goto(`${BASE_URL}/crm`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  await page.locator('.page-tab[data-tab="people"]').click();
  await page.waitForSelector(
    '#people-list-container .data-table tbody tr, #people-list-container .empty-state',
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  const rows = page.locator('#people-list-container .data-table tbody tr');
  if (await rows.count() === 0) return false;
  await rows.first().click();
  await page.waitForURL('**/crm/person/**', { timeout: TIMEOUTS.api });
  await page.waitForFunction(
    () => !document.querySelector('.entity-name')?.textContent?.includes('Loading'),
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  await page.waitForTimeout(500);
  return true;
}

test.describe('CRM — Person detail page', () => {
  // ── Page header ──────────────────────────────────────────────────────────

  test('person detail page shows entity header with back link "← People"', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await expect(page.locator('.entity-back')).toContainText('←', { timeout: TIMEOUTS.element });
  });

  test('person entity name heading is visible and non-empty', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    const name = page.locator('#entity-name, .entity-name');
    await expect(name).toBeVisible({ timeout: TIMEOUTS.element });
    const text = await name.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test('Edit button is visible in the entity header actions', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await expect(page.locator('.entity-actions button:has-text("Edit"), .entity-header button:has-text("Edit")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Tab bar ──────────────────────────────────────────────────────────────

  test('tab bar renders all 7 expected tabs: Overview, Docs, Tax, Communication, Organizers, Workflow, Notes', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');

    const tabBar = page.locator('.tab-bar');
    await expect(tabBar).toBeVisible({ timeout: TIMEOUTS.element });

    for (const tabName of ['Overview', 'Docs', 'Tax', 'Communication', 'Organizers', 'Workflow', 'Notes']) {
      await expect(tabBar.locator(`.tab-item:has-text("${tabName}")`)).toBeVisible({ timeout: TIMEOUTS.element });
    }
  });

  test('"Overview" tab is active and #tab-overview has the active class by default', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await expect(page.locator('.tab-item').filter({ hasText: 'Overview' })).toHaveClass(/active/);
    await expect(page.locator('#tab-overview')).toHaveClass(/active/);
  });

  test('clicking "Docs" tab switches active tab to #tab-docs', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Docs' }).click();
    await expect(page.locator('#tab-docs')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-overview')).not.toHaveClass(/active/);
  });

  test('clicking "Tax" tab switches active tab to #tab-tax', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Tax' }).click();
    await expect(page.locator('#tab-tax')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('clicking "Communication" tab switches active tab', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Communication' }).click();
    await expect(page.locator('.tab-item').filter({ hasText: 'Communication' })).toHaveClass(/active/);
  });

  test('clicking "Notes" tab switches active tab to #tab-notes', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Notes' }).click();
    await expect(page.locator('.tab-item').filter({ hasText: 'Notes' })).toHaveClass(/active/);
    await expect(page.locator('#tab-notes')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('clicking "Organizers" tab switches active tab to #tab-organizers', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Organizers' }).click();
    await expect(page.locator('#tab-organizers')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-overview')).not.toHaveClass(/active/);
  });

  test('"Organizers" tab shows organizer content area', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Organizers' }).click();
    await expect(page.locator('#tab-organizers')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    // Organizer tab shows a dynamic advisor organizer wrap (loading, cards, or empty state)
    await expect(page.locator('#adv-organizer-wrap')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('clicking "Workflow" tab switches active tab to #tab-workflow', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Workflow' }).click();
    await expect(page.locator('#tab-workflow')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-overview')).not.toHaveClass(/active/);
  });

  test('"Workflow" tab shows Active Pipelines header or empty state', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Workflow' }).click();
    await expect(page.locator('#tab-workflow')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    // Either the loading indicator or the list container is visible
    const listVisible = await page.locator('#workflow-list').isVisible();
    const loadingVisible = await page.locator('#workflow-loading').isVisible();
    expect(listVisible || loadingVisible).toBeTruthy();
  });

  test('"Notes" tab shows Internal Notes textarea', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Notes' }).click();
    await expect(page.locator('#tab-notes')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#notes-ta-full')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Edit modal ───────────────────────────────────────────────────────────

  test('clicking Edit opens the edit modal (modal-overlay visible)', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    // Wait for edit button to be enabled (person data loaded)
    const editBtn = page.locator('.entity-actions button:has-text("Edit"), .entity-header button:has-text("Edit")').first();
    await expect(editBtn).toBeVisible({ timeout: TIMEOUTS.api });
    await editBtn.click();
    await expect(page.locator('.modal-overlay:not(.hidden), .modal-overlay.open')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('Edit modal contains First Name input (#ef-fname)', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    const editBtn = page.locator('.entity-actions button:has-text("Edit"), .entity-header button:has-text("Edit")').first();
    await expect(editBtn).toBeVisible({ timeout: TIMEOUTS.api });
    await editBtn.click();
    await expect(page.locator('#ef-fname, input[placeholder="First"]')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('Edit modal contains Last Name input (#ef-lname)', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    const editBtn = page.locator('.entity-actions button:has-text("Edit"), .entity-header button:has-text("Edit")').first();
    await expect(editBtn).toBeVisible({ timeout: TIMEOUTS.api });
    await editBtn.click();
    await expect(page.locator('#ef-lname, input[placeholder="Last"]')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('Edit modal Cancel button closes the modal', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    const editBtn = page.locator('.entity-actions button:has-text("Edit"), .entity-header button:has-text("Edit")').first();
    await expect(editBtn).toBeVisible({ timeout: TIMEOUTS.api });
    await editBtn.click();
    const modal = page.locator('.modal-overlay:not(.hidden), .modal-overlay.open');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.api });
    await modal.locator('button:has-text("Cancel"), .btn-cancel').first().click();
    await page.waitForTimeout(400);
    expect(await page.locator('.modal-overlay.open').count()).toBe(0);
  });

  // ── Docs tab ─────────────────────────────────────────────────────────────

  test('Docs tab: "↑ Upload Document" button is visible', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Docs' }).click();
    await expect(
      page.locator('button:has-text("Upload Document"), button:has-text("↑ Upload")')
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Docs tab: clicking Upload button opens the upload modal', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Docs' }).click();
    await page.locator('button:has-text("Upload Document"), button:has-text("↑ Upload")').first().click();
    await expect(page.locator('#upload-modal')).not.toHaveClass(/hidden/, { timeout: TIMEOUTS.element });
  });

  test('Docs tab: upload modal contains the file-drop zone (.file-drop)', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Docs' }).click();
    await page.locator('button:has-text("Upload Document"), button:has-text("↑ Upload")').first().click();
    await expect(page.locator('#upload-file-drop, .file-drop')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Docs tab: upload modal has Tax Year select (#upload-year) and Category select (#upload-doc-type)', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Docs' }).click();
    await page.locator('button:has-text("Upload Document"), button:has-text("↑ Upload")').first().click();
    await expect(page.locator('#upload-year')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('#upload-doc-type')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Docs tab: upload modal has an Upload submit button that is initially disabled (no file selected)', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Docs' }).click();
    await page.locator('button:has-text("Upload Document"), button:has-text("↑ Upload")').first().click();
    // #upload-submit-btn is disabled until a file is selected
    const submitBtn = page.locator('#upload-submit-btn');
    await expect(submitBtn).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(submitBtn).toBeDisabled();
  });

  test('Docs tab: document content area renders after loading (year folders, doc rows, or empty state)', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Docs' }).click();
    await page.waitForSelector(
      '#docs-content .year-folder, #docs-content .doc-row, #docs-content .empty-state, #docs-content [class*="empty"]',
      { timeout: TIMEOUTS.api }
    ).catch(() => null);
    await expect(page.locator('#docs-content')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Docs tab: when doc rows exist, each has a Download button (.btn-dl)', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Docs' }).click();
    await page.waitForSelector(
      '#docs-content .doc-row, #docs-content .empty-state',
      { timeout: TIMEOUTS.api }
    ).catch(() => null);
    const docRows = page.locator('#docs-content .doc-row');
    if (await docRows.count() > 0) {
      await expect(docRows.first().locator('.btn-dl')).toBeVisible({ timeout: TIMEOUTS.element });
    }
  });

  // ── Overview tab — portal panel ──────────────────────────────────────────

  test('Overview tab: #overview-portal-panel renders after data loads', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    await page.locator('.tab-item').filter({ hasText: 'Overview' }).click();
    await page.waitForSelector('#overview-portal-panel', { timeout: TIMEOUTS.api }).catch(() => null);
    await expect(page.locator('#overview-portal-panel')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('Overview tab: internal notes textarea (#notes-ta) is present', async ({ page }) => {
    const found = await getPersonPage(page);
    if (!found) return test.skip(true, 'No people in the system');
    // Wait for data load
    await page.waitForSelector('#notes-ta', { timeout: TIMEOUTS.api }).catch(() => null);
    await expect(page.locator('#notes-ta')).toBeVisible({ timeout: TIMEOUTS.api });
  });
});
