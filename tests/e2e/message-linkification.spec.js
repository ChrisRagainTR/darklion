// tests/e2e/message-linkification.spec.js
// Static safety gates for clickable pasted links in Inbox and Team Chat message bodies.

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

test.describe('Message linkification', () => {
  test('Inbox safely linkifies pasted URLs', () => {
    const view = compact(readRepoFile('server/views/messages.ejs'));

    expect(view).toContain('function safeLinkHref(raw)');
    expect(view).toContain("if (/^https?:\\/\\//i.test(value)) return value");
    expect(view).toContain("if (/^www\\./i.test(value)) return 'https://' + value");
    expect(view).toContain('target="_blank" rel="noopener noreferrer"');
    expect(view).toContain('function renderBody(body)');
    expect(view).toContain('const linkPattern = /\\[');
  });

  test('Team Chat safely linkifies pasted URLs', () => {
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(view).toContain('function safeLinkHref(raw)');
    expect(view).toContain("if (/^https?:\\/\\//i.test(value)) return value");
    expect(view).toContain("if (/^www\\./i.test(value)) return 'https://' + value");
    expect(view).toContain('target="_blank" rel="noopener noreferrer"');
    expect(view).toContain('function linkifyText(text)');
    expect(view).toContain('linkifyText(bodyText)');
  });
});
