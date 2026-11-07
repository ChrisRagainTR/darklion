// tests/e2e/portal-bulk-upload-static.spec.js
// Static gates for client portal multi-document upload.

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

test.describe('Portal bulk document upload', () => {
  test('upload modal accepts multiple files and posts each to the existing portal upload route', () => {
    const portal = compact(readRepoFile('public/portal.html'));

    expect(portal).toContain('id="fileInput" multiple');
    expect(portal).toContain('let _selectedFiles = []');
    expect(portal).toContain('function setFiles(files)');
    expect(portal).toContain('window._portalSetFiles = setFiles');
    expect(portal).toContain('Array.from(e.dataTransfer?.files || [])');
    expect(portal).toContain('for (const [index, file] of filesToUpload.entries())');
    expect(portal).toContain("fd.append('file', file)");
    expect(portal).toContain("fetch('/portal/upload'");
    expect(portal).toContain('Upload ${list.length} files');
  });
});
