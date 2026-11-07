// Regression coverage for client portal password reset routing.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Client portal password reset', () => {
  test('forgot-password requests identify the account by email', () => {
    const source = readRepoFile('public/portal-login.html');
    const forgotStart = source.indexOf("document.getElementById('forgotLink')");
    expect(forgotStart).toBeGreaterThan(-1);
    const forgotHandler = source.slice(forgotStart, source.indexOf('// ── INVITE FORM', forgotStart));

    expect(source).toContain('id="forgotModal"');
    expect(source).toContain('id="forgotEmail"');
    expect(forgotHandler).toContain('openForgotModal()');
    expect(forgotHandler).toContain("document.getElementById('forgotForm').addEventListener('submit'");
    expect(forgotHandler).toContain("const email = document.getElementById('forgotEmail').value.trim()");
    expect(forgotHandler).toContain('const body = { email }');
    expect(forgotHandler).not.toContain('body.firmSlug');
    expect(forgotHandler).toContain("fetch('/portal-auth/forgot-password'");
    expect(forgotHandler).toContain('body: JSON.stringify(body)');
  });

  test('server resolves the account firm and brands reset links', () => {
    const source = readRepoFile('server/routes/portal-auth.js');
    const forgotStart = source.indexOf("router.post('/forgot-password'");
    expect(forgotStart).toBeGreaterThan(-1);
    const forgotRoute = source.slice(forgotStart, source.indexOf("// --- POST /portal-auth/reset-password", forgotStart));

    expect(forgotRoute).toContain('resolveLoginFirm(email, pool)');
    expect(forgotRoute).toContain('WHERE p.firm_id = $2');
    expect(forgotRoute).toContain('p.portal_invite_token IS NOT NULL');
    expect(forgotRoute).toContain('p.portal_password_hash IS NOT NULL');
    expect(forgotRoute).toContain('p.spouse_portal_invite_token IS NOT NULL');
    expect(forgotRoute).toContain('p.spouse_portal_password_hash IS NOT NULL');
    expect(forgotRoute).toContain('encodeURIComponent(person.firm_slug)');
    expect(forgotRoute).toContain('portal_password_reset_email_failed');
  });

  test('reset link completion activates pending portal accounts', () => {
    const source = readRepoFile('server/routes/portal-auth.js');
    const resetStart = source.indexOf("router.post('/reset-password/:token'");
    expect(resetStart).toBeGreaterThan(-1);
    const resetRoute = source.slice(resetStart, source.indexOf("// --- GET /portal-auth/firm-info", resetStart));

    expect(resetRoute).toContain('spouse_portal_enabled = true');
    expect(resetRoute).toContain('portal_enabled = true');
    expect(resetRoute).toContain('portal_invite_token = NULL');
    expect(resetRoute).toContain('spouse_portal_invite_token = NULL');
  });
});
