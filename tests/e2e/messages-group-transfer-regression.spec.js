'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test.describe('Messages — group tags and transfer regression', () => {
  test('reply API lets active participants reply in the original thread', () => {
    const route = readRepoFile('server/routes/messages.js');

    expect(route).toContain('FROM thread_participants');
    expect(route).toContain('archived_at IS NULL');
    expect(route).toContain('isActiveParticipant');
    expect(route).toContain('thread.staff_user_id !== userId && !isActiveParticipant');
  });

  test('reply API heals latest transfer recipients into thread ownership', () => {
    const route = readRepoFile('server/routes/messages.js');

    expect(route).toContain('isTransferRecipient');
    expect(route).toContain('SELECT forwarded_to_id');
    expect(route).toContain('ORDER BY created_at DESC');
    expect(route).toContain("SET staff_user_id = $1, assigned_to = $1, staff_archived_at = NULL, status = 'open'");
    expect(route).toContain('thread.staff_user_id !== userId && !isActiveParticipant && !isTransferRecipient');
  });

  test('transfer clears owner-local archive state and syncs legacy assignment', () => {
    const route = readRepoFile('server/routes/messages.js');

    expect(route).toContain("SET staff_user_id = $1, assigned_to = $1, staff_archived_at = NULL, status = 'open', last_message_at = NOW()");
    expect(route).toContain('DELETE FROM thread_participants');
  });

  test('thread detail only marks actual participants as shared', () => {
    const route = readRepoFile('server/routes/messages.js');

    expect(route).toContain('LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $3 AND tp.archived_at IS NULL');
    expect(route).toContain('(tp.id IS NOT NULL AND mt.staff_user_id IS DISTINCT FROM $3) as is_participant_check');
    expect(route).not.toContain('(mt.staff_user_id != $3) as is_participant_check');
  });

  test('person and company communication scopes include shared participant threads', () => {
    const route = readRepoFile('server/routes/messages.js');
    const participantScopeMatches = route.match(/EXISTS \(\s+SELECT 1\s+FROM thread_participants tp\s+WHERE tp\.thread_id = mt\.id AND tp\.firm_user_id = \$\$\{params\.length\} AND tp\.archived_at IS NULL\s+\)/g) || [];

    expect(participantScopeMatches.length).toBeGreaterThanOrEqual(2);
  });

  test('web inbox does not force shared participant replies to internal notes', () => {
    const view = readRepoFile('server/views/messages.ejs');

    expect(view).toContain('Participants can reply to the client in shared threads');
    expect(view).toContain('internalToggle.checked = false');
    expect(view).toContain('internalToggle.disabled = false');
    expect(view).not.toContain('internalToggle.checked = !!data.isParticipant');
    expect(view).not.toContain('internalToggle.disabled = !!data.isParticipant');
  });

  test('handoff wording is Transfer in visible web and mobile UI', () => {
    const webView = readRepoFile('server/views/messages.ejs');
    const mobileView = readRepoFile('mobile/src/screens/StaffInboxScreen.tsx');

    expect(webView).toContain('Transfer conversation');
    expect(webView).toContain('Transfer to');
    expect(webView).toContain('Transferred by');
    expect(webView).toContain('Transferred to');
    expect(readRepoFile('server/routes/messages.js')).toContain('Transferred by ${forwarderName} to ${target.name}');
    expect(webView).not.toContain('Forward Thread');
    expect(webView).not.toContain('>Forward<');
    expect(mobileView).toContain('Transferred by {thread.forwardedByName}');
  });
});
