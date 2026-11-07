// tests/e2e/marketing-registration-static.spec.js
// Regression coverage for keeping public firm registration restricted.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Public firm registration messaging', () => {
  test('public marketing and login pages do not link to firm registration', () => {
    const homepage = readRepoFile('public/index.html');
    const login = readRepoFile('public/login.html');

    expect(homepage).not.toContain('href="/register"');
    expect(login).not.toContain('href="/register"');
    expect(homepage).not.toContain('Get Started Free');
    expect(login).not.toContain('Create one free');
  });

  test('pre-launch homepage shows Coming in 2027 instead of signup links', () => {
    const homepage = readRepoFile('public/index.html');

    expect(homepage).not.toContain('subject=Get%20started');
    expect(homepage).not.toContain('href="/join"');
    expect(homepage.match(/>\s*Coming in 2027\s*</g) || []).toHaveLength(4);
  });

  test('direct registration page accurately describes the platform and access', () => {
    const register = readRepoFile('public/register.html');

    expect(register).toContain('AI-Native Practice Management for Tax &amp; Accounting Firms');
    expect(register).toContain('Registration is currently limited to approved firms.');
    expect(register).not.toContain('AI-Powered Bookkeeping for Modern Accounting Firms');
    expect(register).not.toContain("Get started with DarkLion — it's free");
  });
});
