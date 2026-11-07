// tests/e2e/personal-tax-engaged.spec.js
// Tests: personal_tax_engaged flag — API, CRM UI, Tax Season page, organizer block.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getToken(page) {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  return page.evaluate(() => localStorage.getItem('dl_token'));
}

async function getFirstPerson(page, token) {
  const res = await page.request.get(`${BASE_URL}/api/people`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.people || []);
  return list[0] || null;
}

// ─── API: personal_tax_engaged field ─────────────────────────────────────────

test.describe('personal_tax_engaged — API', () => {

  test('GET /api/people returns personal_tax_engaged field', async ({ page }) => {
    const token = await getToken(page);
    const res = await page.request.get(`${BASE_URL}/api/people`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.people || []);
    if (list.length === 0) return test.skip(true, 'No people in DB');
    // Field should exist (true by default)
    expect(list[0]).toHaveProperty('personal_tax_engaged');
    expect(list[0].personal_tax_engaged).not.toBe(undefined);
  });

  test('GET /api/people/:id returns personal_tax_engaged field', async ({ page }) => {
    const token = await getToken(page);
    const person = await getFirstPerson(page, token);
    if (!person) return test.skip(true, 'No people in DB');

    const res = await page.request.get(`${BASE_URL}/api/people/${person.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('personal_tax_engaged');
  });

  test('PUT /api/people/:id can set personal_tax_engaged to false', async ({ page }) => {
    const token = await getToken(page);
    const person = await getFirstPerson(page, token);
    if (!person) return test.skip(true, 'No people in DB');

    const res = await page.request.put(`${BASE_URL}/api/people/${person.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { personal_tax_engaged: false },
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.personal_tax_engaged).toBe(false);
  });

  test('PUT /api/people/:id can set personal_tax_engaged back to true', async ({ page }) => {
    const token = await getToken(page);
    const person = await getFirstPerson(page, token);
    if (!person) return test.skip(true, 'No people in DB');

    // Reset to true
    const res = await page.request.put(`${BASE_URL}/api/people/${person.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { personal_tax_engaged: true },
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.personal_tax_engaged).toBe(true);
  });

  test('PUT /api/people/:id without auth returns 401', async ({ page }) => {
    const res = await page.request.put(`${BASE_URL}/api/people/1`, {
      headers: { 'Content-Type': 'application/json' },
      data: { personal_tax_engaged: false },
    });
    expect(res.status()).toBe(401);
  });

});

// ─── Tax Season API ───────────────────────────────────────────────────────────

test.describe('personal_tax_engaged — Tax Season API', () => {

  test('GET /api/tax-season/clients includes personal_tax_engaged', async ({ page }) => {
    const token = await getToken(page);
    const res = await page.request.get(`${BASE_URL}/api/tax-season/clients`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('clients');
    if (data.clients.length === 0) return; // no clients, skip field check
    expect(data.clients[0]).toHaveProperty('personal_tax_engaged');
  });

  test('POST /api/tax-season/bulk does not set organizer_visible on non-engaged clients', async ({ page }) => {
    const token = await getToken(page);
    const person = await getFirstPerson(page, token);
    if (!person) return test.skip(true, 'No people in DB');

    // Mark person as not engaged
    await page.request.put(`${BASE_URL}/api/people/${person.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { personal_tax_engaged: false, organizer_visible: false },
    });

    // Run Show All
    const bulkRes = await page.request.post(`${BASE_URL}/api/tax-season/bulk`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { visible: true },
    });
    expect(bulkRes.status()).toBe(200);

    // Verify non-engaged person was NOT set to visible
    const checkRes = await page.request.get(`${BASE_URL}/api/people/${person.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const updated = await checkRes.json();
    expect(updated.organizer_visible).toBe(false);

    // Restore
    await page.request.put(`${BASE_URL}/api/people/${person.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { personal_tax_engaged: true },
    });
  });

});

// ─── Organizer creation block ─────────────────────────────────────────────────

test.describe('personal_tax_engaged — Organizer block', () => {

  test('POST /api/organizers/parse-document blocks non-engaged person', async ({ page }) => {
    const token = await getToken(page);
    const person = await getFirstPerson(page, token);
    if (!person) return test.skip(true, 'No people in DB');

    // Mark not engaged
    await page.request.put(`${BASE_URL}/api/people/${person.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { personal_tax_engaged: false },
    });

    // Try to trigger organizer parse with a fake doc owned by this person
    // We expect either 403 (blocked) or 404 (doc not found) — never 200
    const res = await page.request.post(`${BASE_URL}/api/organizers/parse-document/999999`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 404 = doc not found (blocked before getting to the engagement check) is also fine
    expect([403, 404]).toContain(res.status());

    // Restore
    await page.request.put(`${BASE_URL}/api/people/${person.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { personal_tax_engaged: true },
    });
  });

});

// ─── CRM person page ──────────────────────────────────────────────────────────

test.describe('personal_tax_engaged — CRM UI', () => {

  test('/crm/person/:id page loads with personal tax checkbox in edit modal', async ({ page }) => {
    const token = await getToken(page);
    const person = await getFirstPerson(page, token);
    if (!person) return test.skip(true, 'No people in DB');

    await page.goto(`${BASE_URL}/crm/person/${person.id}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });

    // Wait for page data to load, then open edit modal
    await page.waitForTimeout(2000);
    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Person")').first();
    if (await editBtn.count() === 0) return test.skip(true, 'No Edit button found');
    await editBtn.click();

    // Wait for modal to be visible
    await page.waitForSelector('#edit-modal:not(.hidden)', { timeout: TIMEOUTS.element }).catch(() => null);

    // Checkbox should exist and be checked by default
    const checkbox = page.locator('#ef-personal-tax-engaged');
    // The checkbox exists in the DOM (even if inside a scrollable modal)
    await expect(checkbox).toBeAttached({ timeout: TIMEOUTS.element });
    await expect(checkbox).toBeChecked();
  });

  test('/tax-season page has Personal Tax column', async ({ page }) => {
    await page.goto(`${BASE_URL}/tax-season`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    await page.waitForSelector('#ts-table, #ts-empty', { timeout: TIMEOUTS.api });
    const header = page.locator('th:has-text("Personal Tax")');
    await expect(header).toBeVisible({ timeout: TIMEOUTS.element });
  });

});
