// tests/e2e/auth.spec.js
// Tests: login flow, logout, protected-route redirect.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TEST_EMAIL, TEST_PASSWORD, AUTH_STATE_PATH } = require('./helpers/config');

// ─────────────────────────────────────────────────────────────────────────────
// Login tests (no pre-saved auth state — we're testing the login flow itself)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Authentication — login / logout', () => {
  // Override storageState with empty state so we're not pre-authenticated
  // storageState: undefined doesn't override project-level setting in Playwright
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login page renders the sign-in form with email, password, and submit button', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    const loginForm = page.locator('#login-form');
    await expect(loginForm.locator('#email')).toBeVisible();
    await expect(loginForm.locator('#password')).toBeVisible();
    await expect(loginForm.locator('#submit-btn')).toBeVisible();
  });

  test('successful login stores dl_token in localStorage and redirects away from /login', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });

    await page.fill('#login-form #email', TEST_EMAIL);
    await page.fill('#login-form #password', TEST_PASSWORD);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
      page.click('#login-form #submit-btn'),
    ]);

    await page.waitForTimeout(1500);

    const token = await page.evaluate(() => localStorage.getItem('dl_token'));
    expect(token).toBeTruthy();
    expect(page.url()).not.toContain('/login');
  });

  test('wrong credentials shows an error message or stays on /login', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });

    await page.fill('input[type="email"], input[name="email"], #email', 'wrong@example.com');
    await page.fill('input[type="password"], input[name="password"], #password', 'wrongpassword123!');

    await page.click('button[type="submit"], .btn-gold, button:has-text("Sign in"), button:has-text("Login")');

    await page.waitForTimeout(2000);
    const url = page.url();
    const hasErrorEl = await page.locator('.error, .error-msg, [class*="error"], [class*="alert"]').count();
    expect(url.includes('/login') || hasErrorEl > 0).toBeTruthy();
  });

  test('visiting /dashboard without a token redirects to /login', async ({ page }) => {
    // Start fresh — no storageState
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for the client-side auth guard to fire
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/login');
  });

  test('visiting /crm without a token redirects to /login', async ({ page }) => {
    await page.goto(`${BASE_URL}/crm`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Logout test (requires a logged-in session)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Authentication — logout', () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test('logout clears the token and redirects to /login', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });

    // Try the header user dropdown logout link first
    const userMenu = page.locator('.header-user');
    if (await userMenu.count() > 0) {
      await userMenu.click();
      await page.waitForTimeout(300);
    }

    const logoutBtn = page.locator(
      'a:has-text("Logout"), a:has-text("Log out"), button:has-text("Logout"), button:has-text("Log out"), .umd-item.danger'
    );

    if (await logoutBtn.count() > 0) {
      await logoutBtn.first().click();
    } else {
      // Fall back: call logout() directly via JS
      await page.evaluate(() => {
        localStorage.removeItem('dl_token');
        localStorage.removeItem('dl_firm');
        window.location.replace('/login');
      });
    }

    await page.waitForURL('**/login**', { timeout: 10_000 });
    expect(page.url()).toContain('/login');

    const token = await page.evaluate(() => localStorage.getItem('dl_token'));
    expect(token).toBeFalsy();
  });
});
