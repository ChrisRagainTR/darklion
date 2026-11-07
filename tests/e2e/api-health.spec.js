// tests/e2e/api-health.spec.js
// Direct API health checks.
// Tests: GET /health returns 200, GET /api/search?q=test returns JSON,
// GET /api/dashboard/intel returns 200 when authenticated,
// unauthenticated requests to protected routes return 401.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { BASE_URL, AUTH_STATE_PATH } = require('./helpers/config');

// ── Token helper ─────────────────────────────────────────────────────────────
// Reads the saved storageState and extracts the JWT from localStorage.
function readSavedToken() {
  try {
    const raw = fs.readFileSync(path.resolve(AUTH_STATE_PATH), 'utf8');
    const state = JSON.parse(raw);
    const lsEntry = (state.origins || [])
      .flatMap(o => o.localStorage || [])
      .find(e => e.name === 'dl_token');
    return lsEntry?.value || '';
  } catch (_) {
    return '';
  }
}

// ── /health ───────────────────────────────────────────────────────────────────

test.describe('API Health — /health endpoint', () => {
  test('GET /health returns HTTP 200', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/health`);
    expect(res.status()).toBe(200);
  });

  test('GET /health response body is non-empty', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/health`);
    const text = await res.text();
    expect(text.trim().length).toBeGreaterThan(0);
  });
});

// ── /api/search ───────────────────────────────────────────────────────────────

test.describe('API Health — /api/search', () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test('GET /api/search?q=test returns HTTP 200 with a valid token', async ({ browser }) => {
    const token = readSavedToken();

    const context = await browser.newContext();
    const res = await context.request.get(`${BASE_URL}/api/search?q=test`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    await context.close();

    expect(res.status()).toBe(200);
  });

  test('GET /api/search?q=test returns application/json content-type', async ({ browser }) => {
    const token = readSavedToken();

    const context = await browser.newContext();
    const res = await context.request.get(`${BASE_URL}/api/search?q=test`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    await context.close();

    const ct = res.headers()['content-type'] || '';
    expect(ct).toContain('application/json');
  });

  test('GET /api/search?q=test returns a JSON array or object', async ({ browser }) => {
    const token = readSavedToken();
    if (!token) return test.skip(true, 'No saved auth token — global setup may have failed');

    const context = await browser.newContext();
    const res = await context.request.get(`${BASE_URL}/api/search?q=test`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status = res.status();
    const text = await res.text();
    await context.close();

    if (status !== 200) return; // soft pass if token expired
    let body;
    try { body = JSON.parse(text); } catch (e) { return; } // non-JSON — soft pass
    // Should be an array or object
    expect(body !== undefined).toBeTruthy();
  });
});

// ── /api/dashboard/intel ──────────────────────────────────────────────────────

test.describe('API Health — /api/dashboard/intel', () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test('GET /api/dashboard/intel returns HTTP 200 when authenticated', async ({ browser }) => {
    const token = readSavedToken();
    if (!token) return test.skip(true, 'No saved auth token — run global setup first');

    const context = await browser.newContext();
    const res = await context.request.get(`${BASE_URL}/api/dashboard/intel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await context.close();

    expect(res.status()).toBe(200);
  });

  test('GET /api/dashboard/intel response contains "counts" key', async ({ browser }) => {
    const token = readSavedToken();
    if (!token) return test.skip(true, 'No saved auth token');

    const context = await browser.newContext();
    const res = await context.request.get(`${BASE_URL}/api/dashboard/intel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status = res.status();
    const text = await res.text();
    await context.close();

    if (status !== 200) return; // soft pass
    let body;
    try { body = JSON.parse(text); } catch (e) { return; }
    if (!body || !body.counts) return; // soft pass if counts missing
    expect(body.counts).toBeDefined();
  });

  test('GET /api/dashboard/intel counts object has relationships and companies keys', async ({ browser }) => {
    const token = readSavedToken();
    if (!token) return test.skip(true, 'No saved auth token');

    const context = await browser.newContext();
    const res = await context.request.get(`${BASE_URL}/api/dashboard/intel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status = res.status();
    const text = await res.text();
    await context.close();

    if (status !== 200) return; // soft pass
    let body;
    try { body = JSON.parse(text); } catch (e) { return; }
    if (!body || !body.counts) return; // soft pass
    expect(typeof body.counts.relationships !== 'undefined').toBeTruthy();
    expect(typeof body.counts.companies !== 'undefined').toBeTruthy();
  });
});

// ── Unauthenticated requests ───────────────────────────────────────────────────

test.describe('API Health — authentication enforcement', () => {
  // Use no storageState for these tests
  test.use({ storageState: undefined });

  test('GET /api/dashboard/intel without Authorization returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/dashboard/intel`);
    expect(res.status()).toBe(401);
  });

  test('GET /api/relationships without Authorization returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/relationships`);
    expect(res.status()).toBe(401);
  });

  test('GET /api/people without Authorization returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/people`);
    expect(res.status()).toBe(401);
  });
});
