// tests/e2e/portal-close-packages-static.spec.js
// Static gates for portal bookkeeping close package year tabs.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function compact(source) {
  return source.replace(/\s+/g, ' ');
}

test.describe('Portal close package year tabs', () => {
  test('API returns current YTD plus two prior full years', () => {
    const route = compact(readRepoFile('server/routes/portal.js'));

    expect(route).toContain('const currentYear = new Date().getFullYear()');
    expect(route).toContain('const priorYears = [currentYear - 1, currentYear - 2]');
    expect(route).toContain('currentLabel: `${currentYear} YTD`');
    expect(route).toContain('priorYears: priorPackages');
  });

  test('portal renders dynamic close package tabs instead of fixed two-year tabs', () => {
    const portal = compact(readRepoFile('public/portal.html'));

    expect(portal).toContain('const currentYear = data.currentYear || new Date().getFullYear()');
    expect(portal).toContain('const currentLabel = data.currentLabel || `${currentYear} YTD`');
    expect(portal).toContain("data.priorYears.slice(0, 2)");
    expect(portal).toContain('Build dynamic close package viewer: current YTD + last two full years');
    expect(portal).not.toContain('Build two-tab close package viewer');
    expect(portal).not.toContain('new Date().getFullYear() - 1');
  });
});
