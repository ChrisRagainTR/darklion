// tests/e2e/search-bars-static.spec.js
// Static gates for app search bars and shared shell search wiring.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Search bars', () => {
  test('every shell page with the global header includes shared shell search scripts', () => {
    const viewsDir = path.join(repoRoot, 'server/views');
    const offenders = fs.readdirSync(viewsDir)
      .filter(name => name.endsWith('.ejs'))
      .filter(name => {
        const source = fs.readFileSync(path.join(viewsDir, name), 'utf8');
        return source.includes("partials/shell-top")
          && !source.includes("partials/shell-globals")
          && !source.includes("partials/shell-bottom");
      });

    expect(offenders).toEqual([]);
  });

  test('Tax Season has both global search wiring and local client filter wiring', () => {
    const view = readRepoFile('server/views/tax-season.ejs');

    expect(view).toContain("<%- include('partials/shell-top'");
    expect(view).toContain("<%- include('partials/shell-globals') %>");
    expect(view).toContain('id="ts-search"');
    expect(view).toContain("document.getElementById('ts-search').addEventListener('input'");
    expect(view).toContain('filterQuery = this.value');
    expect(view).toContain('renderTable();');
  });

  test('shared global search enables typing and calls the unified search API', () => {
    const shared = readRepoFile('server/views/partials/shell-shared-scripts.ejs');

    expect(shared).toContain("searchBar.removeAttribute('readonly')");
    expect(shared).toContain("searchBar.addEventListener('focus'");
    expect(shared).toContain("searchBar.addEventListener('input'");
    expect(shared).toContain("apiFetch('/api/search?q='");
    expect(shared).toContain('function navigateTo(r)');
  });
});
