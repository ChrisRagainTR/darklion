// tests/e2e/helpers/auth.js
// Reusable login helper. Performs a full browser login and saves storageState.

'use strict';

const { chromium } = require('@playwright/test');
const { BASE_URL, TEST_EMAIL, TEST_PASSWORD, AUTH_STATE_PATH } = require('./config');

/**
 * Full browser login flow.
 * Navigates to /login, fills credentials, submits, waits for redirect,
 * then saves storageState to AUTH_STATE_PATH.
 *
 * @param {import('@playwright/test').BrowserContext | import('@playwright/test').Browser} browserOrContext
 * @returns {Promise<import('@playwright/test').BrowserContext>} The authenticated context.
 */
async function login(browserOrContext) {
  let context;

  if (browserOrContext.newPage) {
    context = browserOrContext;
  } else {
    context = await browserOrContext.newContext();
  }

  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });

  await page.fill('input[type="email"], input[name="email"], #email', TEST_EMAIL);
  await page.fill('input[type="password"], input[name="password"], #password', TEST_PASSWORD);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
    page.click('button[type="submit"], .btn-gold, button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")'),
  ]);

  await page.waitForFunction(
    () => !!localStorage.getItem('dl_token'),
    { timeout: 20_000 }
  ).catch(() => {});

  await context.storageState({ path: AUTH_STATE_PATH });
  await page.close();
  return context;
}

/**
 * Injects a JWT into localStorage via addInitScript.
 * @param {import('@playwright/test').Page} page
 * @param {string} token
 */
async function injectToken(page, token) {
  await page.addInitScript((t) => {
    localStorage.setItem('dl_token', t);
  }, token);
}

module.exports = { login, injectToken };
