// tests/e2e/settings.spec.js
// Tests: settings page loads, tab bar renders with Branding/Domains/API-Keys tabs,
// each tab switches correctly, and the correct content is shown.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.use({ storageState: 'tests/.auth/user.json' });

test.describe('Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  });

  // ── Page loads ────────────────────────────────────────────────────────────

  test('settings page loads without redirecting to /login', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
    expect(page.url()).toContain('/settings');
  });

  test('settings page shows the "⚙️ Settings" heading in h1', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Settings', { timeout: TIMEOUTS.element });
  });

  test('settings page renders the top header and sidebar', async ({ page }) => {
    await expect(page.locator('.top-header')).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Tab bar ───────────────────────────────────────────────────────────────

  test('settings tab bar (.settings-tabs) is visible', async ({ page }) => {
    await expect(page.locator('.settings-tabs')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"🎨 Firm Branding" tab button is visible', async ({ page }) => {
    await expect(
      page.locator('.settings-tab-btn').filter({ hasText: 'Firm Branding' })
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"🌐 Custom Domains" tab button is visible', async ({ page }) => {
    await expect(
      page.locator('.settings-tab-btn').filter({ hasText: 'Custom Domains' })
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('"🔑 API Keys" tab button is visible', async ({ page }) => {
    await expect(
      page.locator('.settings-tab-btn').filter({ hasText: 'API Keys' })
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Default tab ───────────────────────────────────────────────────────────

  test('"Firm Branding" tab is active by default', async ({ page }) => {
    await expect(
      page.locator('.settings-tab-btn').filter({ hasText: 'Firm Branding' })
    ).toHaveClass(/active/, { timeout: TIMEOUTS.element });
  });

  test('#tab-branding panel is visible by default', async ({ page }) => {
    await expect(page.locator('#tab-branding')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-branding')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Branding tab content ──────────────────────────────────────────────────

  test('Branding tab: logo preview area is visible (#logo-preview)', async ({ page }) => {
    await expect(page.locator('#logo-preview')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Branding tab: Display Name input (#b-display-name) is visible', async ({ page }) => {
    await expect(page.locator('#b-display-name')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Branding tab: Tagline input (#b-tagline) is visible', async ({ page }) => {
    await expect(page.locator('#b-tagline')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Branding tab: Contact Email input (#b-contact-email) is visible', async ({ page }) => {
    await expect(page.locator('#b-contact-email')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Branding tab: Brand Color picker (#b-color-picker) is visible', async ({ page }) => {
    await expect(page.locator('#b-color-picker')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Branding tab: "Save Branding" button is visible', async ({ page }) => {
    await expect(page.locator('button:has-text("Save Branding")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Custom Domains tab ────────────────────────────────────────────────────

  test('clicking "Custom Domains" tab activates #tab-domains panel', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'Custom Domains' }).click();
    await expect(page.locator('#tab-domains')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-domains')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Domains tab: new domain input (#new-domain-input) is visible', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'Custom Domains' }).click();
    await expect(page.locator('#new-domain-input')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Domains tab: "+ Add Domain" button is visible', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'Custom Domains' }).click();
    await expect(page.locator('button:has-text("+ Add Domain")')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('Domains tab: setup instructions section (.instructions) is visible', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'Custom Domains' }).click();
    await expect(page.locator('.instructions')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── API Keys tab ──────────────────────────────────────────────────────────

  test('clicking "API Keys" tab activates #tab-api-keys panel', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'API Keys' }).click();
    await expect(page.locator('#tab-api-keys')).toHaveClass(/active/, { timeout: TIMEOUTS.element });
    await expect(page.locator('#tab-api-keys')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('API Keys tab: "🔑 API Keys" section heading is visible', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'API Keys' }).click();
    await expect(
      page.locator('#tab-api-keys h2').filter({ hasText: 'API Keys' })
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('API Keys tab: "+ Generate New Key" button is visible', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'API Keys' }).click();
    await expect(
      page.locator('button:has-text("Generate New Key"), button:has-text("+ Generate")')
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('API Keys tab: #api-tokens-list container is visible', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'API Keys' }).click();
    await expect(page.locator('#api-tokens-list')).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('API Keys tab: clicking "+ Generate New Key" opens the new token modal', async ({ page }) => {
    await page.locator('.settings-tab-btn').filter({ hasText: 'API Keys' }).click();
    await page.locator('button:has-text("Generate New Key"), button:has-text("+ Generate")').click();
    await expect(page.locator('#new-token-modal')).toBeVisible({ timeout: TIMEOUTS.element });
  });
});
