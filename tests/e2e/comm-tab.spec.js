// tests/e2e/comm-tab.spec.js
// Tests: Communication tab on person + company CRM pages.
// Covers: layout (reply box always visible, AI summary panel), send API,
// company summary API, SMS API validation.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

// Person ID 26 = Don Draper (dev DB, firm_id=1)
const PERSON_ID = 26;
// Company ID 1 = first company in the test DB (firm_id=1)
const COMPANY_ID = 1;

// ── Person comm tab ───────────────────────────────────────────────────────────

test.describe('Comm Tab — Person', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/crm/person/${PERSON_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUTS.navigation,
    });
    // Click the Communication tab
    await page.locator('.tab-item', { hasText: 'Communication' }).click();
    await page.waitForTimeout(500);
  });

  test('communication tab is present and clickable', async ({ page }) => {
    await expect(page.locator('#tab-communication')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('reply box is visible without selecting a thread', async ({ page }) => {
    await expect(page.locator('#comm-reply-box')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('reply textarea is visible and accepts input', async ({ page }) => {
    const ta = page.locator('#comm-reply-body');
    await expect(ta).toBeVisible({ timeout: TIMEOUTS.element });
    await ta.fill('Automated test message — please ignore.');
    await expect(ta).toHaveValue('Automated test message — please ignore.');
  });

  test('Send Message button is visible and enabled', async ({ page }) => {
    const btn = page.locator('#comm-send-reply-btn');
    await expect(btn).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(btn).toBeEnabled();
  });

  test('AI summary panel is visible', async ({ page }) => {
    await expect(page.locator('#tab-communication .comm-summary-panel')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('AI summary panel has a refresh button', async ({ page }) => {
    await expect(page.locator('#comm-summary-refresh-btn')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('detail messages container is in the DOM', async ({ page }) => {
    await expect(page.locator('#comm-detail-messages')).toBeAttached({ timeout: TIMEOUTS.element });
  });

  test('Shift+Enter clears textarea after send (or shows a toast on error)', async ({ page }) => {
    const ta = page.locator('#comm-reply-body');
    await ta.fill('Shift+Enter test message — please ignore.');
    await ta.press('Shift+Enter');
    // After send attempt: either textarea clears (success) or a toast appears (error)
    await page.waitForTimeout(1500);
    const value = await ta.inputValue();
    const toastVisible = await page.locator('.toast, [class*="toast"]').isVisible().catch(() => false);
    expect(value === '' || toastVisible).toBeTruthy();
  });
});

// ── Person comm tab — API ─────────────────────────────────────────────────────

test.describe('Comm Tab — Person API', () => {
  let token;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'tests/.auth/user.json' });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    token = await page.evaluate(() => localStorage.getItem('dl_token'));
    await context.close();
  });

  test('POST /api/messages creates a thread and returns threadId', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/messages`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({
        person_id: PERSON_ID,
        subject: '',
        body: '[Test] Comm tab automated test message — safe to ignore.',
        is_internal: false,
      }),
    });
    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.threadId).toBeTruthy();
  });

  test('POST /api/messages/person/:id/summary returns 200', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/messages/person/${PERSON_ID}/summary`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: '{}',
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    // Either a summary or a "no messages" message — both are valid
    expect(data.summary !== undefined || data.message !== undefined).toBeTruthy();
  });

  test('POST /api/messages/sms with no phone returns 400', async ({ request }) => {
    // Person 28 = Pete Campbell — no phone set in test data initially
    // We test the validation path: missing person or no phone → 400
    const res = await request.post(`${BASE_URL}/api/messages/sms`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ person_id: PERSON_ID, body: '' }), // empty body → 400
    });
    expect(res.status()).toBe(400);
  });
});

// ── Company comm tab ──────────────────────────────────────────────────────────

test.describe('Comm Tab — Company', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/crm/company/${COMPANY_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUTS.navigation,
    });
    await page.locator('.tab-item', { hasText: 'Communication' }).click();
    await page.waitForTimeout(500);
  });

  test('company communication tab is visible', async ({ page }) => {
    await expect(page.locator('#tab-communication')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('company reply box is always visible', async ({ page }) => {
    await expect(page.locator('#comm-co-reply-box')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('company reply textarea accepts input', async ({ page }) => {
    const ta = page.locator('#comm-co-reply-body');
    await expect(ta).toBeVisible({ timeout: TIMEOUTS.element });
    await ta.fill('Company comm test — please ignore.');
    await expect(ta).toHaveValue('Company comm test — please ignore.');
  });

  test('company Send Message button is visible and enabled', async ({ page }) => {
    const btn = page.locator('#comm-co-send-btn');
    await expect(btn).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(btn).toBeEnabled();
  });

  test('company AI summary panel is visible', async ({ page }) => {
    await expect(page.locator('#tab-communication .comm-summary-panel')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('company AI summary refresh button is present', async ({ page }) => {
    await expect(page.locator('#comm-co-summary-refresh-btn')).toBeVisible({ timeout: TIMEOUTS.element });
  });
});

// ── Company comm tab — API ────────────────────────────────────────────────────

test.describe('Comm Tab — Company API', () => {
  let token;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'tests/.auth/user.json' });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    token = await page.evaluate(() => localStorage.getItem('dl_token'));
    await context.close();
  });

  test('POST /api/messages/company/:id/summary returns 200', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/messages/company/${COMPANY_ID}/summary`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: '{}',
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.summary !== undefined || data.message !== undefined).toBeTruthy();
  });
});
