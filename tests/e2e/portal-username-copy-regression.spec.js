// tests/e2e/portal-username-copy-regression.spec.js
// Regression coverage for making client portal usernames clear during invite/login.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Client portal username copy', () => {
  test('portal login tells clients their email address is their username', () => {
    const source = readRepoFile('public/portal-login.html');

    expect(source).toContain('Email Address / Username');
    expect(source).toContain('Use the email address where you received your invite.');
    expect(source).toContain('inviteUsernameNote');
    expect(source).toContain('You will sign in with ');
    expect(source).toContain('document.getElementById(\'email\').value = data.email;');
  });

  test('portal invite email includes the username email address', () => {
    const source = readRepoFile('server/services/email.js');

    expect(source).toContain('const username = to ||');
    expect(source).toContain('Your username is your email address:');
    expect(source).toContain('${esc(username)}');
  });
});
