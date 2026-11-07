// tests/e2e/portal.spec.js
// Tests: client portal login page loads and renders the expected form elements.
// We verify the page loads correctly without completing the full portal flow.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

// Portal login is public — no auth state needed
test.use({ storageState: undefined });

test.describe('Client Portal — login page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/client-login`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUTS.navigation,
    });
  });

  test('portal login page loads with body content (not a blank error page)', async ({ page }) => {
    const bodyText = await page.locator('body').textContent();
    expect(bodyText?.trim().length).toBeGreaterThan(10);
  });

  test('portal URL contains "/client-login" or "/portal" (not redirected to staff /login)', async ({ page }) => {
    expect(page.url().includes('/client-login') || page.url().includes('/portal')).toBeTruthy();
    expect(page.url()).not.toBe(`${BASE_URL}/login`);
  });

  test('portal login page shows an email input', async ({ page }) => {
    await expect(
      page.locator('input[type="email"], input[name="email"], #email, #portal-email, input[placeholder*="email"], input[placeholder*="Email"]').first()
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('portal login page shows a password or access-code input', async ({ page }) => {
    await expect(
      page.locator(
        'input[type="password"], input[name="password"], #password, #portal-password, ' +
        'input[placeholder*="password"], input[placeholder*="Password"], ' +
        'input[placeholder*="code"], input[placeholder*="Code"]'
      ).first()
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('portal login page shows a submit / login button', async ({ page }) => {
    await expect(
      page.locator(
        'button[type="submit"], .btn-gold, .btn-submit, ' +
        'button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Access"), ' +
        'button:has-text("Continue"), button:has-text("Login")'
      ).first()
    ).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('portal login page shows a branding logo or firm name', async ({ page }) => {
    const branding = page.locator(
      'img[alt], .logo, [class*="logo"], [class*="brand"], h1, .firm-name'
    ).first();
    await expect(branding).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('entering wrong credentials shows an error or stays on /portal', async ({ page }) => {
    await page.fill(
      'input[type="email"], input[name="email"], #email, #portal-email',
      'notaclient@example.com'
    );
    await page.fill(
      'input[type="password"], input[name="password"], #password, input[placeholder*="password"]',
      'wrongpassword'
    );
    await page.click(
      'button[type="submit"], .btn-gold, .btn-submit, button:has-text("Sign in"), button:has-text("Login")'
    );
    await page.waitForTimeout(2000);

    // Should stay on the portal login or show an error
    const url = page.url();
    const errEl = await page.locator('.error, .error-msg, [class*="error"], [class*="alert"], [role="alert"]').count();
    expect(url.includes('/client-login') || url.includes('/portal') || errEl > 0).toBeTruthy();
  });
});
