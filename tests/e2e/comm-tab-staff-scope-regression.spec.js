// Static regression checks for CRM communication tab staff scoping.
// The comm tab should open the current staff member's client thread, not the
// most recent thread owned by any staff member.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

test.describe('CRM comm tab staff scoping', () => {
  test('person comm tab loads only the current staff thread', () => {
    const view = read('server/views/crm-person.ejs');
    expect(view).toContain('apiFetch(`/api/messages/person/${commPersonId}?scope=mine`)');
    expect(view).toContain('apiFetch(`/api/messages/person/${personId}?scope=mine`)');
    expect(view).not.toContain('apiFetch(`/api/messages/person/${commPersonId}`)');
    expect(view).not.toContain('apiFetch(`/api/messages/person/${personId}`)');
  });

  test('company comm tab loads only current staff threads', () => {
    const view = read('server/views/crm-company.ejs');
    expect(view).toContain('apiFetch(`/api/messages/company/${commCoId}?scope=mine`)');
    expect(view).toContain('apiFetch(`/api/messages/company/${companyId}?scope=mine`)');
    expect(view).not.toContain('apiFetch(`/api/messages/company/${commCoId}`)');
    expect(view).not.toContain('apiFetch(`/api/messages/company/${companyId}`)');
  });

  test('message list endpoints support scope=mine with current firm user', () => {
    const route = read('server/routes/messages.js');
    expect(route).toContain("if (req.query.scope === 'mine')");
    expect(route).toContain('const userId = await currentFirmUserId(req)');
    expect(route).toContain('(mt.staff_user_id = $${params.length} AND mt.staff_archived_at IS NULL)');
    expect(route).toContain('FROM thread_participants tp');
    expect(route).toContain('tp.thread_id = mt.id AND tp.firm_user_id = $${params.length} AND tp.archived_at IS NULL');
  });

  test('staff archive is staff-local and portal streams ignore archive status', () => {
    const messagesRoute = read('server/routes/messages.js');
    const portalRoute = read('server/routes/portal.js');
    const mobilePush = read('server/services/mobilePush.js');
    const db = read('server/db.js');

    expect(db).toContain('ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS staff_archived_at TIMESTAMPTZ DEFAULT NULL');
    expect(messagesRoute).toContain('UPDATE message_threads SET staff_archived_at = NOW() WHERE id = $1 AND firm_id = $2');
    expect(messagesRoute).not.toContain("UPDATE message_threads SET status = 'archived' WHERE id = $1 AND firm_id = $2");
    expect(portalRoute).not.toContain("WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3 AND status != 'archived'");
    expect(portalRoute).toContain('WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3');
    expect(portalRoute).toContain("UPDATE message_threads SET status = 'open', staff_archived_at = NULL, last_message_at = NOW() WHERE id = $1");
    expect(mobilePush).toContain('AND (mt.staff_user_id != $2 OR mt.staff_archived_at IS NULL)');
  });

  test('external replies to stale foreign threads reroute to sender thread', () => {
    const route = read('server/routes/messages.js');
    expect(route).toContain('External replies from a stale/foreign CRM thread still redirect');
    expect(route).toContain('mt.person_id = $2');
    expect(route).toContain('mt.staff_user_id = $3');
    expect(route).toContain('sendThreadId = thread.id');
    expect(route).toContain('threadId: sendThreadId');
  });

  test('send success visibly reloads the resolved staff thread', () => {
    const personView = read('server/views/crm-person.ejs');
    const companyView = read('server/views/crm-company.ejs');

    expect(personView).toContain('if (data.threadId) commActiveThreadId = data.threadId;');
    expect(personView).toContain('await loadThread(commActiveThreadId, false);');
    expect(personView).not.toContain("quietRefresh('crm-person-comm-after-send'");

    expect(companyView).toContain('if (data.threadId) commCoActiveThreadId = data.threadId;');
    expect(companyView).toContain('await loadCoThread(commCoActiveThreadId, false);');
    expect(companyView).not.toContain("quietRefresh('crm-company-comm-after-send'");
  });
});
