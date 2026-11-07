const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

test.describe('Communication archive foundation contracts', () => {
  test('schema creates immutable archive tables and soft-removal columns', () => {
    const db = read('server/db.js');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS communication_archive_events');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS communication_archive_outbox');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS communication_archive_exports');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS communication_archive_access_events');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS communication_archive_holds');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS communication_archive_reconciliation_runs');
    expect(db).toContain('ALTER TABLE messages ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ');
    expect(db).toContain('ALTER TABLE messages ADD COLUMN IF NOT EXISTS removed_by_staff_user_id');
  });

  test('client message delete path is soft-remove and archives the event', () => {
    const messages = read('server/routes/messages.js');
    expect(messages).toContain('archiveClientMessageCreated');
    expect(messages).toContain('archiveClientMessageRemoved');
    expect(messages).toContain("removal_reason = 'staff_removed'");
    expect(messages).toContain('SET removed_at = NOW()');
    expect(messages).not.toMatch(/DELETE FROM messages WHERE id = \$1/);
  });

  test('team chat create/edit/remove archive events are required', () => {
    const teamChat = read('server/routes/team-chat.js');
    expect(teamChat).toContain('archiveTeamChatMessageCreated');
    expect(teamChat).toContain('archiveTeamChatMessageEdited');
    expect(teamChat).toContain('archiveTeamChatMessageRemoved');
  });

  test('email reply failure cleanup no longer hard-deletes messages', () => {
    const email = read('server/services/emailReplyTokens.js');
    expect(email).toContain("removal_reason = 'inbound_email_failed'");
    expect(email).not.toContain("DELETE FROM messages WHERE id = $1 AND thread_id = $2");
  });

  test('export and health routes are mounted for staff', () => {
    const index = read('server/index.js');
    expect(index).toContain("app.use('/api/communication-exports'");
    expect(index).toContain("app.use('/api/communication-archive/health'");
    const exportsRoute = read('server/routes/communication-exports.js');
    expect(exportsRoute).toContain('createExport');
    expect(exportsRoute).toContain('requireStaffUser');
  });

  test('settings exposes a clear Archives entry and communications export action', () => {
    const settings = read('server/views/settings.ejs');
    const exportsPage = read('server/views/communication-exports.ejs');
    expect(settings).toContain("switchTab('archives')");
    expect(settings).toContain('Open communications archive');
    expect(settings).toContain('/api/communication-archive/health');
    expect(exportsPage).toContain('Settings / Archives');
    expect(exportsPage).toContain('Generate export');
    expect(exportsPage).toContain('Download ZIP');
  });

  test('storage writer makes object lock optional for the MVP', () => {
    const storage = read('server/services/communicationArchiveStorage.js');
    expect(storage).toContain('COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED');
    expect(storage).toContain("ObjectLockMode: 'COMPLIANCE'");
    expect(storage).toContain('ObjectLockRetainUntilDate');
    expect(storage).toContain("IfNoneMatch: '*'");
  });

  test('every message writer requires fail-closed archive capture', () => {
    const clientWriters = [
      'server/routes/bulk-send.js',
      'server/routes/emma-chat.js',
      'server/routes/messages.js',
      'server/routes/pipelines.js',
      'server/routes/portal.js',
      'server/routes/tax-delivery.js',
      'server/services/emailReplyTokens.js',
      'server/services/emmaDraft.js',
      'server/services/inboundSms.js',
      'server/services/pipelineActions.js',
    ];
    for (const file of clientWriters) {
      const source = read(file);
      expect(source, file).toContain('INSERT INTO messages');
      expect(source, file).toContain('archiveClientMessageCreatedFailClosed');
    }

    const agentWork = read('server/routes/agent-work.js');
    expect(agentWork).toContain('INSERT INTO native_team_chat_messages');
    expect(agentWork).toContain('archiveTeamChatMessageCreatedFailClosed');
  });

  test('exports are checksum verified and packaged with attachments', () => {
    const archive = read('server/services/communicationArchive.js');
    const signing = read('server/services/communicationArchiveSigning.js');
    expect(archive).toContain('row.payload_json');
    expect(archive).toContain('Archive receipt payload is missing.');
    expect(archive).toContain("key: `${prefix}/export.zip`");
    expect(archive).toContain('attachment.archive_object_key');
    expect(signing).toContain("algorithm: 'SHA256'");
    expect(signing).toContain('sha256Hex(message)');
  });

  test('ZIP generation uses the installed archiver v8 API', () => {
    const archive = read('server/services/communicationArchive.js');
    expect(archive).toContain("const { ZipArchive } = require('archiver')");
    expect(archive).toContain('new ZipArchive({ zlib: { level: 9 } })');
  });

  test('backfill uses keyset pagination rather than a total row cap', () => {
    const backfill = read('server/services/communicationArchiveBackfill.js');
    expect(backfill).toContain('while (true)');
    expect(backfill).toContain('m.id > $2');
    expect(backfill).toContain('lastId = rows[rows.length - 1].id');
  });

  test('canonical events include required regulator-facing fields', () => {
    const canonical = read('server/services/communicationArchiveCanonical.js');
    expect(canonical).toContain('schema_version');
    expect(canonical).toContain('event_id');
    expect(canonical).toContain('occurred_at');
    expect(canonical).toContain('content_sha256');
    expect(canonical).toContain('RETENTION_YEARS = 7');
  });
});
