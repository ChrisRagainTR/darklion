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

test.describe('CRM Communication archived conversations', () => {
  test('person and company message endpoints expose staff-local archived threads', () => {
    const routes = compact(readRepoFile('server/routes/messages.js'));

    expect(routes.match(/const showArchived = req\.query\.view === 'archived'/g)?.length).toBeGreaterThanOrEqual(3);
    expect(routes).toContain("router.get('/person/:personId'");
    expect(routes).toContain("router.get('/company/:companyId'");
    expect(routes).toContain("mt.staff_user_id = $${params.length} AND (mt.staff_archived_at IS NOT NULL OR mt.status = 'archived')");
    expect(routes).toContain('tp.firm_user_id = $${params.length} AND tp.archived_at IS NOT NULL');
    expect(routes).toContain('isArchived: showArchived');
  });

  for (const [label, file, prefix] of [
    ['person', 'server/views/crm-person.ejs', 'comm'],
    ['company', 'server/views/crm-company.ejs', 'comm-co'],
  ]) {
    test(`${label} Communication tab can browse, navigate, and restore archives`, () => {
      const view = compact(readRepoFile(file));

      expect(view).toContain(`id="${prefix}-view-archived"`);
      expect(view).toContain(`id="${prefix}-archive-thread-select"`);
      expect(view).toContain(`id="${prefix}-archive-banner"`);
      expect(view).toContain('Read-only until restored');
      expect(view).toContain('view=archived');
      expect(view).toContain('/restore');
      expect(view).toContain('Conversation Dates');
      expect(view).toContain('comm-date-divider');
      expect(view).toContain("scrollIntoView({ behavior:'smooth', block:'start' })");
    });
  }

  test('archived views hide the composer while active views retain the summary panel', () => {
    const personView = compact(readRepoFile('server/views/crm-person.ejs'));
    const companyView = compact(readRepoFile('server/views/crm-company.ejs'));

    expect(personView).toContain("replyBox.style.display = archived ? 'none' : ''");
    expect(companyView).toContain("replyBox.style.display = archived ? 'none' : ''");
    expect(personView).toContain("sideTitle.textContent = archived ? 'Conversation Dates' : '🤖 30-Day Summary'");
    expect(companyView).toContain("sideTitle.textContent = archived ? 'Conversation Dates' : '🤖 30-Day Summary'");
    expect(personView).not.toContain("getElementById('comm-detail-header').innerHTML = ''");
    expect(companyView).not.toContain("getElementById('comm-co-detail-header').innerHTML = ''");
  });
});
