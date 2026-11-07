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

test.describe('Client message archive viewer', () => {
  test('archive inbox queries remain firm-scoped and local to the current staff user', () => {
    const routes = compact(readRepoFile('server/routes/messages.js'));

    expect(routes).toContain("const showArchived = req.query.view === 'archived'");
    expect(routes).toContain('WHERE mt.firm_id = $1');
    expect(routes).toContain('mt.staff_user_id = $2 AND (mt.staff_archived_at IS NOT NULL OR mt.status =');
    expect(routes).toContain('mt.staff_user_id != $2 AND tp.id IS NOT NULL AND tp.archived_at IS NOT NULL');
    expect(routes).toContain('[firmId, userId, showArchived]');
  });

  test('staff can restore owned and shared archived client threads', () => {
    const routes = compact(readRepoFile('server/routes/messages.js'));

    expect(routes).toContain("router.put('/:threadId/restore'");
    expect(routes).toContain('SET staff_archived_at = NULL');
    expect(routes).toContain('SET archived_at = NULL');
    expect(routes).toContain('WHERE id = $1 AND firm_id = $2');
  });

  test('Messages has an archived tab with read-only detail and restore controls', () => {
    const view = compact(readRepoFile('server/views/messages.ejs'));

    expect(view).toContain('id="tabArchived"');
    expect(view).toContain("switchTab('archived')");
    expect(view).toContain("apiFetch('/api/messages?view=archived')");
    expect(view).toContain('id="archivedThreadBanner"');
    expect(view).toContain('Read-only until it is restored');
    expect(view).toContain('function restoreThread(threadId)');
    expect(view).toContain('(isTaskThread || data.isArchived)');
  });

  test('full conversation history has desktop and compact date navigation', () => {
    const view = compact(readRepoFile('server/views/messages.ejs'));

    expect(view).toContain('id="dateNavigator"');
    expect(view).toContain('id="dateJumpSelect"');
    expect(view).toContain('class="message-date-divider"');
    expect(view).toContain('function buildInboxMessageTimeline(messages)');
    expect(view).toContain('function renderDateNavigation(messages)');
    expect(view).toContain("scrollIntoView({ behavior: 'smooth', block: 'start' })");
    expect(view).toContain("addEventListener('scroll'");
  });
});
