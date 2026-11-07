// tests/e2e/organizer-advisor-actions-static.spec.js
// Static gates for advisor organizer item controls.

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

test.describe('Advisor organizer item actions', () => {
  test('staff API exposes firm-provides toggle and item upload routes', () => {
    const route = compact(readRepoFile('server/routes/organizer.js'));

    expect(route).toContain("router.put('/:personId/:year/items/:itemId/sentinel'");
    expect(route).toContain("router.post('/:personId/:year/items/:itemId/upload'");
    expect(route).toContain('SET sentinel_provides = $1');
    expect(route).toContain("SET status = 'uploaded', document_id = $1");
    expect(route).toContain("uploaded_by_type, uploaded_by_id");
    expect(route).toContain("'staff', $9, 'firm_uploaded', 'organizer'");
  });

  test('advisor Organizer tab gives every item firm-provides, upload, and delete controls', () => {
    const view = compact(readRepoFile('server/views/crm-person.ejs'));

    expect(view).toContain('const sentinelBtn = `<button onclick="toggleAdvItemSentinel');
    expect(view).toContain('const uploadBtn = `<label title="Upload this item from the office"');
    expect(view).toContain('${sentinelBtn}');
    expect(view).toContain('${uploadBtn}');
    expect(view).toContain('deleteAdvItem(${item.id}');
    expect(view).toContain('async function toggleAdvItemSentinel(itemId, year, sentinelProvides)');
    expect(view).toContain('async function uploadAdvItemFile(input, itemId, year)');
    expect(view).toContain('onclick="addAdvItem(${org.id},\'${esc(org.tax_year)}\')"');
    expect(view).not.toContain('/api/organizers/${personId}/2025/items');
  });
});
