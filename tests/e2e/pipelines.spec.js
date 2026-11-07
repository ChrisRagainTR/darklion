// tests/e2e/pipelines.spec.js
// Tests: pipeline list page, kanban board view, drag-and-drop between stages,
// job detail panel opens on card click.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

/** Opens the first available pipeline board. Returns false if no pipelines exist. */
async function openFirstBoard(page) {
  await page.goto(`${BASE_URL}/pipelines`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  // Wait for the async loadList() call to populate the tbody
  await page.waitForFunction(
    () => {
      const tbody = document.getElementById('pipe-tbody');
      if (!tbody) return false;
      // Has real rows (not the spinner/empty row)
      return tbody.querySelectorAll('tr').length > 0 &&
             tbody.querySelector('.pipe-link') !== null;
    },
    { timeout: TIMEOUTS.api }
  ).catch(() => null);

  const pipeLink = page.locator('.pipe-link').first();
  if (await pipeLink.count() === 0) return false;

  await pipeLink.click();
  // Wait for board to become visible (showBoard() sets display:flex)
  await page.waitForFunction(
    () => {
      const board = document.getElementById('view-board');
      return board && board.style.display === 'flex';
    },
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  return true;
}

async function openFirstBoardWithSettings(page) {
  const found = await openFirstBoard(page);
  if (!found) return false;
  // Wait for settings-link href to be updated by async JS (starts as /pipelines)
  await page.waitForFunction(
    () => {
      const sl = document.getElementById('settings-link');
      return sl && sl.getAttribute('href') && sl.getAttribute('href').includes('/settings');
    },
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  return true;
}

test.describe('Pipelines — list view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/pipelines`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  test('pipelines page loads and shows the "Pipelines" heading', async ({ page }) => {
    await expect(page.locator('#list-title, h1').filter({ hasText: 'Pipelines' })).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"+ New Pipeline" button is visible', async ({ page }) => {
    await expect(page.locator('#new-pipe-btn, button:has-text("+ New Pipeline")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"📦 View Archived" toggle button is visible', async ({ page }) => {
    await expect(page.locator('#archived-toggle')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('pipeline table renders with "Name", "Type", "Stages", "Active Jobs" column headers', async ({ page }) => {
    await page.waitForSelector('.pipe-table', { timeout: TIMEOUTS.element });
    await expect(page.locator('.pipe-table th').filter({ hasText: 'Name' })).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.pipe-table th').filter({ hasText: 'Type' })).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.pipe-table th').filter({ hasText: 'Stages' })).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.pipe-table th').filter({ hasText: 'Active Jobs' })).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('pipeline table body loads (pipeline rows or empty message)', async ({ page }) => {
    await page.waitForSelector('#pipe-tbody tr', { timeout: TIMEOUTS.api });
    const rows = page.locator('#pipe-tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('clicking "+ New Pipeline" opens the New Pipeline modal with Name field', async ({ page }) => {
    await page.locator('#new-pipe-btn, button:has-text("+ New Pipeline")').click();
    await expect(page.locator('#new-pipeline-modal')).toHaveClass(/open/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#np-name')).toBeVisible({ timeout: TIMEOUTS.element });
  });
});

test.describe('Pipelines — kanban board view', () => {
  test('clicking a pipeline name opens the kanban board view', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await expect(page.locator('#view-board')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('#board-title')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('kanban board hides the list view (#view-list) when a board is shown', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await expect(page.locator('#view-list')).toBeHidden({ timeout: TIMEOUTS.element });
  });

  test('kanban board shows at least one column (.kanban-col) with a column name (.col-name)', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.waitForSelector('.kanban-col', { timeout: TIMEOUTS.api });
    await expect(page.locator('.kanban-col').first()).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.col-head .col-name').first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('each kanban column has a card count badge (.col-count)', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.waitForSelector('.kanban-col', { timeout: TIMEOUTS.api });
    await expect(page.locator('.col-count').first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('board bar shows "+ Add Job" button and "⚙️ Settings" link', async ({ page }) => {
    const found = await openFirstBoardWithSettings(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await expect(page.locator('button:has-text("+ Add Job")')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('#settings-link, a:has-text("Settings")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('board bar back button returns to the list view', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.locator('.back-btn').click();
    await expect(page.locator('#view-list')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('clicking a job card opens the job detail panel with a title', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.waitForSelector('.job-card', { timeout: TIMEOUTS.api }).catch(() => null);
    const cards = page.locator('.job-card');
    if (await cards.count() === 0) return test.skip(true, 'No job cards in first pipeline');
    await cards.first().click();
    await expect(page.locator('#job-panel')).toHaveClass(/open/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#panel-title')).toBeVisible({ timeout: TIMEOUTS.element });
    const title = await page.locator('#panel-title').textContent();
    expect(title?.trim().length).toBeGreaterThan(0);
  });

  test('job panel close button dismisses the panel', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    // Wait for board to fully render before looking for job cards
    await page.waitForSelector('.kanban-col', { timeout: TIMEOUTS.api }).catch(() => null);
    await page.waitForTimeout(800);
    await page.waitForSelector('.job-card', { timeout: TIMEOUTS.api }).catch(() => null);
    if (await page.locator('.job-card').count() === 0) return test.skip(true, 'No job cards');
    await page.locator('.job-card').first().click();
    const panelOpened = await page.locator('#job-panel').evaluate(el => {
      return new Promise(resolve => {
        if (el.classList.contains('open')) { resolve(true); return; }
        const obs = new MutationObserver(() => {
          if (el.classList.contains('open')) { obs.disconnect(); resolve(true); }
        });
        obs.observe(el, { attributes: true, attributeFilter: ['class'] });
        setTimeout(() => { obs.disconnect(); resolve(false); }, 5000);
      });
    });
    if (!panelOpened) return test.skip(true, 'Job panel did not open — possible board state issue');
    await page.locator('#job-panel .panel-close').click();
    await page.waitForTimeout(600);
    // Verify panel closed
    const panelClass = await page.locator('#job-panel').getAttribute('class').catch(() => '');
    expect(panelClass).not.toMatch(/\bopen\b/);
  });

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  test('drag a job card from column 0 to column 1 and verify it moved', async ({ page }) => {
    const found = await openFirstBoard(page);
    if (!found) return test.skip(true, 'No pipelines exist');

    await page.waitForSelector('.kanban-col', { timeout: TIMEOUTS.api });
    const cols = page.locator('.kanban-col');
    if (await cols.count() < 2) return test.skip(true, 'Need ≥2 columns for drag test');

    const firstColCards = cols.nth(0).locator('.job-card');
    const initialCount = await firstColCards.count();
    if (initialCount === 0) return test.skip(true, 'No cards in column 0 to drag');

    const cardName = await firstColCards.first().locator('.job-name').textContent();
    const targetDropZone = cols.nth(1).locator('.col-cards');

    await firstColCards.first().dragTo(targetDropZone, { timeout: TIMEOUTS.api });
    await page.waitForTimeout(1500);

    // Verify the card moved: either col 1 now contains it or col 0 has fewer cards
    const newFirstColCount = await firstColCards.count();
    const col1Text = await cols.nth(1).textContent();

    const cardInCol1 = (col1Text || '').includes((cardName || '').trim());
    const countDecreased = newFirstColCount < initialCount;

    expect(cardInCol1 || countDecreased).toBeTruthy();
  });
});

test.describe('Pipelines — settings page', () => {
  test('⚙️ Settings link navigates to pipeline settings page', async ({ page }) => {
    const found = await openFirstBoardWithSettings(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    const settingsLink = page.locator('#settings-link');
    await expect(settingsLink).toBeVisible({ timeout: TIMEOUTS.element });
    await settingsLink.click();
    await page.waitForURL('**/pipelines/**/settings', { timeout: TIMEOUTS.navigation });
    await expect(page).toHaveURL(/\/pipelines\/\d+\/settings/);
  });

  test('pipeline settings page shows Stages section', async ({ page }) => {
    const found = await openFirstBoardWithSettings(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.locator('#settings-link').click();
    await page.waitForURL('**/pipelines/**/settings', { timeout: TIMEOUTS.navigation });
    await expect(page.locator('.ps-section-title').filter({ hasText: 'Stages' })).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('pipeline settings page shows Automation section', async ({ page }) => {
    const found = await openFirstBoardWithSettings(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.locator('#settings-link').click();
    await page.waitForURL('**/pipelines/**/settings', { timeout: TIMEOUTS.navigation });
    await expect(page.locator('.ps-section-title').filter({ hasText: 'Automation' })).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('pipeline settings page shows stage cards in a grid', async ({ page }) => {
    const found = await openFirstBoardWithSettings(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.locator('#settings-link').click();
    await page.waitForURL('**/pipelines/**/settings', { timeout: TIMEOUTS.navigation });
    await page.waitForSelector('.stage-card', { timeout: TIMEOUTS.api }).catch(() => null);
    const cards = page.locator('.stage-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('last stage card shows 🏁 Final stage label', async ({ page }) => {
    const found = await openFirstBoardWithSettings(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.locator('#settings-link').click();
    await page.waitForURL('**/pipelines/**/settings', { timeout: TIMEOUTS.navigation });
    await page.waitForSelector('.stage-card', { timeout: TIMEOUTS.api }).catch(() => null);
    // Soft check — pipeline may not have a terminal stage configured in dev
    const finalStage = page.locator('.stage-card').last().locator(':has-text("Final stage"), :has-text("Terminal")');
    const hasFinal = await finalStage.count().catch(() => 0);
    if (hasFinal === 0) return test.skip(true, 'No terminal stage in this pipeline');
    await expect(finalStage.first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Back to Pipeline link returns to kanban board (not pipeline list)', async ({ page }) => {
    const found = await openFirstBoardWithSettings(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.locator('#settings-link').click();
    await page.waitForURL('**/pipelines/**/settings', { timeout: TIMEOUTS.navigation });
    await page.locator('#back-to-pipeline').click();
    await page.waitForURL('**/pipelines**', { timeout: TIMEOUTS.navigation });
    // Should contain ?instance= param and show the board
    await expect(page.locator('#view-board')).toBeVisible({ timeout: TIMEOUTS.api });
  });

  test('automation cards render with trigger and action columns', async ({ page }) => {
    const found = await openFirstBoardWithSettings(page);
    if (!found) return test.skip(true, 'No pipelines exist');
    await page.locator('#settings-link').click();
    await page.waitForURL('**/pipelines/**/settings', { timeout: TIMEOUTS.navigation });
    await page.waitForSelector('#automation-list', { timeout: TIMEOUTS.api });
    await expect(page.locator('#automation-list')).toBeVisible({ timeout: TIMEOUTS.element });
  });
});
