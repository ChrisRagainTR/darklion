// tests/e2e/helpers/config.js
// Central configuration for all E2E tests.
// Override via environment variables before running.

'use strict';

const BASE_URL = process.env.BASE_URL || 'https://darklion-ai-development.up.railway.app';
const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';

if (!TEST_EMAIL || !TEST_PASSWORD) {
  console.warn(
    '[config] WARNING: TEST_EMAIL and/or TEST_PASSWORD not set. ' +
    'Auth tests will fail. Set them via environment variables.'
  );
}

const TIMEOUTS = {
  /** Navigation / page load */
  navigation: 30_000,
  /** Short element wait (element should already be there) */
  element: 10_000,
  /** Wait for an async API response to paint content */
  api: 20_000,
};

/** Path where saved auth state (storageState) is written */
const AUTH_STATE_PATH = 'tests/.auth/user.json';

module.exports = { BASE_URL, TEST_EMAIL, TEST_PASSWORD, TIMEOUTS, AUTH_STATE_PATH };
