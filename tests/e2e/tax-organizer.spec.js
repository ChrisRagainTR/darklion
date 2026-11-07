// tests/e2e/tax-organizer.spec.js
// Tests: Tax organizer API endpoints and person Organizers tab.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

/** Navigate to first person's detail page via CRM People tab */
async function goToFirstPerson(page) {
  await page.goto(`${BASE_URL}/crm`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  // Switch to People tab
  await page.locator('.tab-btn:has-text("People"), button:has-text("People"), [data-tab="people"]').first().click();
  // Wait for the people list container to populate (async API call)
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('#people-list-container table tbody tr');
      return rows.length > 0;
    },
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  const firstRow = page.locator('#people-list-container table tbody tr').first();
  if (await firstRow.count() === 0) return false;
  await firstRow.click();
  await page.waitForURL(/\/crm\/person\//, { timeout: TIMEOUTS.navigation });
  return true;
}

test.describe('Tax Organizer', () => {

  // ── API health ────────────────────────────────────────────────────────────

  test('GET /api/organizers/:personId/all returns 200 with a valid token', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const token = await page.evaluate(() => localStorage.getItem('dl_token'));
    expect(token).toBeTruthy();

    // Get first person
    const peopleRes = await page.request.get(`${BASE_URL}/api/people`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const people = await peopleRes.json();
    const arr = Array.isArray(people) ? people : (people.people || []);
    if (!arr.length) return test.skip(true, 'No people in test account');

    const res = await page.request.get(`${BASE_URL}/api/organizers/${arr[0].id}/all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBeTruthy();
  });

  test('GET /api/organizers/:personId/all without auth returns 401', async ({ page }) => {
    const res = await page.request.get(`${BASE_URL}/api/organizers/1/all`);
    expect(res.status()).toBe(401);
  });

  // ── Person Organizers tab ─────────────────────────────────────────────────

  test('person detail Organizers tab shows organizer content area', async ({ page }) => {
    const found = await goToFirstPerson(page);
    if (!found) return test.skip(true, 'No people in test account');

    // Click Organizers tab — uses .tab-item with onclick="switchTab('organizers', this)"
    const orgTab = page.locator('.tab-item:has-text("Organizers"), .tab-btn:has-text("Organizers"), button:has-text("Organizers")');
    await expect(orgTab).toBeVisible({ timeout: TIMEOUTS.element });
    await orgTab.click();

    // Organizer content area should render
    const content = page.locator('#tab-organizers');
    await expect(content).toBeVisible({ timeout: TIMEOUTS.element });
    const bodyText = await content.textContent();
    expect(bodyText.trim().length).toBeGreaterThan(0);
  });

  test('Organizers tab shows "Send Organizer" button or existing organizers', async ({ page }) => {
    const found = await goToFirstPerson(page);
    if (!found) return test.skip(true, 'No people in test account');

    const orgTab = page.locator('.tab-item:has-text("Organizers"), .tab-btn:has-text("Organizers"), button:has-text("Organizers")');
    await orgTab.click();
    await page.waitForTimeout(1500);

    // "Upload Drake Organizer" is a <label><span class="btn btn-gold"> — not a <button>
    const sendBtn = page.locator(
      'button:has-text("Organizer"), .btn:has-text("Organizer"), label:has-text("Organizer"), span.btn:has-text("Organizer")'
    );
    const orgCard = page.locator('.organizer-card, .organizer-row, .organizer-item, #adv-organizer-wrap .card, #adv-organizer-wrap [style*="border-radius"]');
    const hasSendBtn = await sendBtn.count() > 0;
    const hasOrgCard = await orgCard.count() > 0;
    expect(hasSendBtn || hasOrgCard).toBeTruthy();
  });

});
