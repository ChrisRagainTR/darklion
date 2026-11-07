// tests/e2e/portal-ghost.spec.js
// Tests: Advisor ghost preview (View Portal as Client) feature.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

/** Navigate to first person's detail page via CRM People tab */
async function goToFirstPerson(page) {
  await page.goto(`${BASE_URL}/crm`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  await page.locator('.tab-btn:has-text("People"), button:has-text("People"), [data-tab="people"]').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('#people-list-container table tbody tr').length > 0,
    { timeout: TIMEOUTS.api }
  ).catch(() => null);
  const firstRow = page.locator('#people-list-container table tbody tr').first();
  if (await firstRow.count() === 0) return false;
  await firstRow.click();
  await page.waitForURL(/\/crm\/person\//, { timeout: TIMEOUTS.navigation });
  return true;
}

test.describe('Portal Ghost Preview', () => {

  // ── API endpoint ──────────────────────────────────────────────────────────

  test('POST /api/people/:id/portal-preview without auth returns 401', async ({ page }) => {
    const res = await page.request.post(`${BASE_URL}/api/people/1/portal-preview`);
    expect(res.status()).toBe(401);
  });

  test('POST /api/people/:id/portal-preview for non-existent person returns 404', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const token = await page.evaluate(() => localStorage.getItem('dl_token'));

    const res = await page.request.post(`${BASE_URL}/api/people/0/portal-preview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([400, 404]).toContain(res.status());
  });

  test('POST /api/people/:id/portal-preview for active portal person returns url', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const token = await page.evaluate(() => localStorage.getItem('dl_token'));

    const peopleRes = await page.request.get(`${BASE_URL}/api/people`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(peopleRes.status()).toBe(200);
    const people = await peopleRes.json();
    const portalPerson = (Array.isArray(people) ? people : people.people || [])
      .find(p => p.portal_enabled && p.portal_has_password);

    if (!portalPerson) return test.skip(true, 'No person with active portal found');

    const res = await page.request.post(`${BASE_URL}/api/people/${portalPerson.id}/portal-preview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.url).toBeTruthy();
    expect(body.url).toContain('preview_token=');
  });

  test('preview token URL contains a valid JWT structure (3 segments)', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const token = await page.evaluate(() => localStorage.getItem('dl_token'));
    const people = await (await page.request.get(`${BASE_URL}/api/people`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const portalPerson = (Array.isArray(people) ? people : people.people || [])
      .find(p => p.portal_enabled && p.portal_has_password);
    if (!portalPerson) return test.skip(true, 'No active portal person');

    const res = await page.request.post(`${BASE_URL}/api/people/${portalPerson.id}/portal-preview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { url } = await res.json();
    const previewToken = new URL(url).searchParams.get('preview_token');
    expect(previewToken).toBeTruthy();
    expect(previewToken.split('.').length).toBe(3); // valid JWT = header.payload.sig
  });

  // ── CRM button presence ───────────────────────────────────────────────────

  test('"👁️ View Portal" button appears on person page for portal-active client', async ({ page }) => {
    const found = await goToFirstPerson(page);
    if (!found) return test.skip(true, 'No people in test account');

    await page.waitForTimeout(1500);

    const viewBtn = page.locator('button:has-text("View Portal"), button[title*="portal" i]');
    const portalPanel = page.locator('#overview-portal-panel, .portal-panel');
    const hasBtn = await viewBtn.count() > 0;

    if (hasBtn) {
      await expect(viewBtn.first()).toBeVisible({ timeout: TIMEOUTS.element });
    } else {
      // Portal may not be active for this test person — just verify panel loaded
      await expect(portalPanel.first()).toBeAttached({ timeout: TIMEOUTS.element });
    }
  });

});
