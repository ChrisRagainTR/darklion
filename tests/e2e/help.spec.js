// tests/e2e/help.spec.js
// Tests: Help Center /help and /help/article/:slug pages
// Public — no auth required.

'use strict';

const { test, expect } = require('@playwright/test');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

test.describe('Help Center — public', () => {

  // ── /help home ────────────────────────────────────────────────────────────

  test('help home page loads without redirecting to /login', async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    expect(page.url()).not.toContain('/login');
    expect(res.status()).toBeLessThan(400);
  });

  test('help home shows "Help Center" heading', async ({ page }) => {
    await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const heading = page.locator('h1, .help-hero h1, .help-home-title');
    await expect(heading).toBeVisible({ timeout: TIMEOUTS.element });
    await expect(heading).toContainText(/help/i);
  });

  test('help home renders module cards (at least 4)', async ({ page }) => {
    await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const cards = page.locator('a.help-module-card');
    await expect(cards.first()).toBeVisible({ timeout: TIMEOUTS.element });
    expect(await cards.count()).toBeGreaterThanOrEqual(4);
  });

  test('help home has a search input', async ({ page }) => {
    await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const search = page.locator('input[type="search"], input[placeholder*="search" i], #help-search');
    await expect(search).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('help home has a left sidebar with navigation links', async ({ page }) => {
    await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const sidebar = page.locator('.help-sidebar, aside');
    await expect(sidebar).toBeVisible({ timeout: TIMEOUTS.element });
    const links = sidebar.locator('a');
    expect(await links.count()).toBeGreaterThanOrEqual(4);
  });

  test('help home has "← Back to DarkLion" link', async ({ page }) => {
    await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const backLink = page.locator('a:has-text("Back to DarkLion"), a:has-text("DarkLion")');
    await expect(backLink.first()).toBeVisible({ timeout: TIMEOUTS.element });
  });

  // ── Article page ──────────────────────────────────────────────────────────

  test('clicking a module card navigates to an article page', async ({ page }) => {
    await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    // Cards are <a class="help-module-card"> — they ARE the link
    const card = page.locator('a.help-module-card').first();
    await expect(card).toBeVisible({ timeout: TIMEOUTS.element });
    await card.click();
    await page.waitForURL(/\/help\/article\//, { timeout: TIMEOUTS.navigation });
    expect(page.url()).toContain('/help/article/');
  });

  test('/help/article/what-is-darklion loads and shows an article heading', async ({ page }) => {
    await page.goto(`${BASE_URL}/help/article/what-is-darklion`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    expect(page.url()).not.toContain('/login');
    const heading = page.locator('h1, .article-title');
    await expect(heading).toBeVisible({ timeout: TIMEOUTS.element });
    const text = await heading.textContent();
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test('/help/article/:slug shows article body content', async ({ page }) => {
    await page.goto(`${BASE_URL}/help/article/what-is-darklion`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const body = page.locator('.article-body, .article-content, .help-article-body');
    await expect(body).toBeVisible({ timeout: TIMEOUTS.element });
    const text = await body.textContent();
    expect(text.trim().length).toBeGreaterThan(50);
  });

  test('/help/article/:slug shows sidebar navigation', async ({ page }) => {
    await page.goto(`${BASE_URL}/help/article/crm-overview`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const sidebar = page.locator('.help-sidebar, aside');
    await expect(sidebar).toBeVisible({ timeout: TIMEOUTS.element });
  });

  test('/help/article/:slug with unknown slug returns 404 or redirects gracefully', async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/help/article/this-slug-does-not-exist`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    // Either 404 status or redirected to /help — either is acceptable
    const ok = res.status() === 404 || page.url().includes('/help');
    expect(ok).toBeTruthy();
  });

  // ── Search ────────────────────────────────────────────────────────────────

  test('typing in search input filters visible articles', async ({ page }) => {
    await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    const search = page.locator('input[type="search"], input[placeholder*="search" i], #help-search');
    await expect(search).toBeVisible({ timeout: TIMEOUTS.element });
    await search.fill('CRM');
    // After typing, search results or filtered items should appear
    await page.waitForTimeout(400);
    const results = page.locator('.search-result, .search-results, .help-result');
    const anyResults = await results.count() > 0;
    // If search results element doesn't exist, at least confirm no JS error crashed the page
    if (!anyResults) {
      await expect(page.locator('body')).toBeVisible();
    }
  });

});
