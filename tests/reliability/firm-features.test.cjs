'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

test('chat rollout hides and restores the button while leaving Team Chat realtime active', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const shell = fs.readFileSync(path.resolve(__dirname, '../../server/views/partials/shell-close.ejs'), 'utf8');
  let enabled = false, unavailable = false, featureRequests = 0, sessionRequests = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body><main>' + shell });
    if (url.pathname === '/firms/features') {
      featureRequests++;
      return route.fulfill({ status: unavailable ? 503 : 200, contentType: 'application/json', body: JSON.stringify({ features: { embedded_chat: enabled } }) });
    }
    if (url.pathname === '/api/emma-chat/session') {
      sessionRequests++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages: [{ role: 'assistant', content: 'Synthetic saved chat' }] }) });
    }
    return route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('dl_token', 'synthetic.' + btoa(JSON.stringify({ firmId: 31, userId: 41 })) + '.synthetic');
    window._testChannels = [];
    window.Pusher = function() {};
    window.DLRealtime = { create: () => ({ subscribe: name => {
      window._testChannels.push(name); return { bind() {} };
    } }) };
  });
  try {
    await page.goto('http://synthetic.invalid/');
    await page.waitForFunction(() => window._testChannels.length === 2);
    assert.equal(await page.locator('#agent-float-btn').isVisible(), false);
    await page.evaluate(() => { window.toggleAgentFloat(); window.afpSend(); });
    assert.equal(sessionRequests, 0);
    assert.ok((await page.evaluate(() => window._testChannels)).includes('private-team-chat-31-41'));
    enabled = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#agent-float-btn').waitFor({ state: 'visible' });
    await page.locator('#agent-float-btn').click();
    await page.getByText('Synthetic saved chat', { exact: true }).waitFor();
    assert.equal(sessionRequests, 1);
    unavailable = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#agent-float-btn').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#agent-float-panel').evaluate(el => el.classList.contains('open')), false);
    assert.equal(await page.locator('#afp-messages').textContent(), '');
    assert.ok(featureRequests >= 3); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
