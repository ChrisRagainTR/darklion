// tests/e2e/agent-activity-log-contract.spec.js
// Source-level contract checks for the firm-wide Agent Activity Log API.
// Keeps coverage non-mutating for dev/prod-like databases.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Agent activity log contracts', () => {
  test('schema is firm-scoped, append-only, indexed, and idempotent by dedupe key', () => {
    const source = readRepoFile('server/db.js');

    expect(source).toContain('CREATE TABLE IF NOT EXISTS activity_events');
    expect(source).toContain('firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE');
    expect(source).toContain('event_type TEXT NOT NULL');
    expect(source).toContain("metadata JSONB NOT NULL DEFAULT '{}'");
    expect(source).toContain('activity_events_firm_date_recent');
    expect(source).toContain('activity_events_firm_type_recent');
    expect(source).toContain('activity_events_firm_dedupe_key');
  });

  test('agent route requires activity_log_read and reuses cached message summaries', () => {
    const route = readRepoFile('server/routes/agent-work.js');
    const service = readRepoFile('server/services/activityLog.js');

    expect(route).toContain("router.get('/activity-log', requireCapability('activity_log_read')");
    expect(route).toContain('buildDailyAgentBrief({');
    expect(route).toContain('parseEventTypes');
    expect(route).toContain('safeLimit(req.query.limit, 100, 500)');
    expect(service).toContain('FROM conversation_summaries');
    expect(service).toContain('client_threads');
    expect(service).toContain('team_chats');
  });

  test('activity service scopes reads by firm and inserts idempotently', () => {
    const source = readRepoFile('server/services/activityLog.js');

    expect(source).toContain('async function recordActivityEvent');
    expect(source).toContain('ON CONFLICT (firm_id, dedupe_key)');
    expect(source).toContain('async function listActivityLog');
    expect(source).toContain("const where = ['firm_id = $1']");
    expect(source).toContain('event_type = ANY');
    expect(source).toContain('console.error(\'[activityLog] recordActivityEvent non-fatal:\'');
  });

  test('workflow producers record key V1 activity events without raw S3 keys', () => {
    const organizer = readRepoFile('server/routes/organizer.js');
    const documents = readRepoFile('server/routes/documents.js');
    const portal = readRepoFile('server/routes/portal.js');
    const taxDelivery = readRepoFile('server/routes/tax-delivery.js');
    const pipelineTriggers = readRepoFile('server/services/pipelineTriggers.js');

    expect(organizer).toContain("eventType: 'organizer_submitted'");
    expect(organizer).toContain("eventType: 'organizer_reopened'");
    expect(organizer).toContain("eventType: 'organizer_closed'");
    expect(documents).toContain("eventType: 'document_uploaded_by_staff'");
    expect(portal).toContain("eventType: 'document_uploaded_by_client'");
    expect(portal).toContain("eventType: 'client_statement_uploaded'");
    expect(portal).toContain("eventType: 'tax_return_approved'");
    expect(portal).toContain("eventType: 'tax_return_signed'");
    expect(taxDelivery).toContain("eventType: 'tax_return_deployed'");
    expect(pipelineTriggers).toContain("eventType: 'pipeline_trigger_fired'");

    for (const source of [organizer, documents, portal, taxDelivery, pipelineTriggers]) {
      expect(source).not.toContain('metadata: { s3_key');
      expect(source).not.toContain('metadata: { signedKey');
    }
  });

  test('docs expose the activity-log endpoint and capability', () => {
    const docs = readRepoFile('docs/api-docs.md');
    const openapi = readRepoFile('docs/openapi.json');

    expect(docs).toContain('/api/agent-work/activity-log');
    expect(docs).toContain('activity_log_read');
    expect(openapi).toContain('"/api/agent-work/activity-log"');
    expect(openapi).toContain('"ActivityLogResponse"');
    expect(openapi).toContain('"activity_log_read"');
  });
});
