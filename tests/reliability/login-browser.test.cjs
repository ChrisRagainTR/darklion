'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');

test('branded client login needs no firm selection, and MFA appears only when required', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const bodies = []; const errors = []; let signedIn = false; let meProbes = 0;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/client-login/example-firm') return route.fulfill({ contentType: 'text/html', body: '<script>window.__FIRM_SLUG__="example-firm"</script>' + fs.readFileSync(path.join(root, 'public/portal-login.html'), 'utf8') });
      if (url.pathname === '/portal-auth/firm-info') {
        assert.equal(url.searchParams.get('slug'), 'example-firm');
        return route.fulfill({ json: { firmName: 'Example Firm', primaryColor: '#123456', logoUrl: '/example-logo.svg', portalLogoUrl: '/example-icon.png', portalIconUrl: '/example-icon.png', portalLogoStyle: 'icon', appName: 'DarkLion' } });
      }
      if (url.pathname === '/portal-auth/login') {
        const body = route.request().postDataJSON(); bodies.push(body);
        if (body.mfaCode !== '123456') return route.fulfill({ status: 401, json: { code: 'MFA_REQUIRED', error: 'Enter your authentication code.' } });
        // Web sign-in: the server sets the HttpOnly session cookie and leaves the token out.
        signedIn = true;
        return route.fulfill({ json: { session: 'cookie', person: { firstName: 'Client' } } });
      }
      if (url.pathname === '/portal/me') {
        meProbes++;
        return signedIn ? route.fulfill({ json: { firstName: 'Client' } }) : route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      }
      if (url.pathname === '/portal-auth/forgot-password') {
        bodies.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname === '/portal') return route.fulfill({ contentType: 'text/html', body: 'Signed in' });
      if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: '' });
      return route.fulfill({ body: '' });
    });
    await page.goto('http://127.0.0.1/client-login/example-firm');
    await page.waitForFunction(() => document.title === 'Example Firm — Client Portal');
    assert.equal(await page.locator('#firm-code').count(), 0);
    assert.equal(await page.locator('#mfa-code').isVisible(), false);
    assert.equal(await page.locator('.logo-wrap img').getAttribute('src'), '/example-icon.png');
    assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), '/example-icon.png');
    assert.equal(await page.locator('.logo-wrap img').getAttribute('data-logo-style'), 'icon');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--gold').trim()), '#123456');
    await page.locator('#email').fill('client@example.invalid');
    await page.locator('#password').fill('Synthetic1!');
    await page.locator('#forgotLink').click();
    await page.locator('#forgotBtn').click();
    await page.waitForFunction(() => !document.getElementById('forgotModal').classList.contains('open'));
    assert.deepEqual(bodies.shift(), { email: 'client@example.invalid' });
    await page.locator('#loginBtn').click();
    await page.locator('#mfa-code').waitFor({ state: 'visible' });
    assert.deepEqual(bodies[0], { email: 'client@example.invalid', password: 'Synthetic1!', mfaCode: '', session: 'cookie' });
    await page.locator('#mfa-code').fill('123456');
    await page.locator('#loginBtn').click();
    await page.waitForURL('**/portal');
    assert.equal(await page.evaluate(() => localStorage.getItem('portalToken')), null, 'no token in browser storage');
    assert.equal(meProbes, 2, 'one signed-out probe on load, one cookie check after sign-in');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('client sign-in page forwards an existing cookie session to the portal, but not right after the portal sent it there', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const bounced of [false, true]) {
      const page = await browser.newPage();
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/client-login') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/portal-login.html'), 'utf8') });
        if (url.pathname === '/storage-setup') return route.fulfill({ contentType: 'text/html', body: '' });
        if (url.pathname === '/portal/me') return route.fulfill({ json: { firstName: 'Client' } });
        if (url.pathname === '/portal-auth/firm-info') return route.fulfill({ json: { firmName: 'Example Firm' } });
        if (url.pathname === '/portal') return route.fulfill({ contentType: 'text/html', body: 'Signed in' });
        if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: '' });
        return route.fulfill({ body: '' });
      });
      if (bounced) {
        await page.goto('http://127.0.0.1/storage-setup');
        await page.evaluate(() => sessionStorage.setItem('portalAuthBounce', String(Date.now())));
      }
      await page.goto('http://127.0.0.1/client-login');
      if (bounced) {
        await page.waitForTimeout(500);
        assert.match(new URL(page.url()).pathname, /^\/client-login$/);
      } else {
        await page.waitForURL('**/portal');
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
