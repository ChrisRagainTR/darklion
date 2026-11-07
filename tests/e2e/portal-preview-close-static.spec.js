// tests/e2e/portal-preview-close-static.spec.js
// Static gates for advisor preview close behavior in desktop shell.

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

test.describe('Portal advisor preview close', () => {
  test('preview banner uses desktop-safe close handler, not inline window.close', () => {
    const portal = compact(readRepoFile('public/portal.html'));

    expect(portal).toContain('onclick="closeAdvisorPreview()"');
    expect(portal).toContain('window.closeAdvisorPreview = function closeAdvisorPreview()');
    expect(portal).toContain('window.open may reuse the main app window');
    expect(portal).toContain('window.opener && !window.opener.closed');
    expect(portal).toContain('window.location.href = document.referrer');
    expect(portal).toContain("window.location.href = '/dashboard'");
    expect(portal).not.toContain('onclick="window.close()"');
  });
});
