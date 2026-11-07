'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, expect } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '../..');
const readRepoFile = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test.describe('document upload notification regression contracts', () => {
  test('schema stores firm-scoped upload events, documents, recipients, and routes', () => {
    const source = readRepoFile('server/db.js');

    for (const table of [
      'document_notification_routes',
      'document_upload_notifications',
      'document_upload_notification_documents',
      'document_upload_notification_recipients',
    ]) {
      expect(source).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(source).toContain("CHECK(folder_category IN ('tax','bookkeeping','other'))");
    expect(source).toContain('UNIQUE(firm_id, folder_category, staff_user_id)');
    expect(source).toContain('UNIQUE(notification_id, document_id)');
    expect(source).toContain('UNIQUE(notification_id, staff_user_id)');
    expect(source).toContain('idx_document_upload_recipients_inbox');
    expect(source).toContain('ON document_upload_notification_recipients(firm_id, staff_user_id, archived_at, read_at, notification_id)');
  });

  test('generic schema never guesses routing identities and Settings warns for empty categories', () => {
    const schema = readRepoFile('server/db.js');
    const settings = readRepoFile('server/views/settings.ejs');

    expect(schema).not.toContain('BOOTSTRAP APPROVED DOCUMENT ROUTES');
        expect(schema).not.toContain('document_notification_routes_initialized');
    expect(settings).toContain('data-route-warning');
    expect(settings).toContain('No recipients configured');
    expect(settings).toContain("warning.hidden = selected.size > 0");
  });

  test('service normalizes organizer to tax and excludes chat or staff uploads', () => {
    const { normalizeCategory, qualifiesForNotification } = require('../../server/services/documentUploadNotifications');

    expect(normalizeCategory('organizer')).toBe('tax');
    expect(normalizeCategory('bookkeeping')).toBe('bookkeeping');
    expect(normalizeCategory('unexpected')).toBe('other');
    expect(qualifiesForNotification({ folder_section: 'client_uploaded', folder_category: 'tax', uploaded_by_type: 'client' })).toBe(true);
    expect(qualifiesForNotification({ folder_section: 'client_uploaded', folder_category: 'message_docs', uploaded_by_type: 'client' })).toBe(false);
    expect(qualifiesForNotification({ folder_section: 'firm_uploaded', folder_category: 'tax', uploaded_by_type: 'staff' })).toBe(false);
  });

  test('grouping keys do not collide when mutable dimensions contain delimiters', async () => {
    const { createDocumentUploadNotification } = require('../../server/services/documentUploadNotifications');
    const groupingKeys = [];
    const db = {
      async connect() {
        return {
          async query(sql, params = []) {
            if (sql.includes('hashtext($2)')) groupingKeys.push(params[1]);
            return { rows: [] };
          },
          release() {},
        };
      },
    };
    const baseDocument = {
      owner_type: 'person', owner_id: 5, folder_section: 'client_uploaded',
      folder_category: 'organizer', uploaded_by_type: 'client', display_name: 'Tax document.pdf',
    };

    await createDocumentUploadNotification({
      firmId: 3,
      uploaderPersonId: 5,
      document: { ...baseDocument, id: 77, folder_subcategory: 'quarter:one', year: '2025' },
      db,
    });
    await createDocumentUploadNotification({
      firmId: 3,
      uploaderPersonId: 5,
      document: { ...baseDocument, id: 78, folder_subcategory: 'quarter', year: 'one:2025' },
      db,
    });

    expect(groupingKeys).toHaveLength(2);
    expect(groupingKeys[0]).not.toBe(groupingKeys[1]);
  });

  test('service transactionally creates a routed notification and emits metadata-free refresh data', async () => {
    const { createDocumentUploadNotification } = require('../../server/services/documentUploadNotifications');
    const calls = [];
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes('FROM document_notification_routes')) return { rows: [{ staff_user_id: 11 }, { staff_user_id: 12 }] };
        if (sql.includes('FROM document_upload_notifications')) return { rows: [] };
        if (sql.includes('INSERT INTO document_upload_notifications')) return { rows: [{ id: 90, file_count: 1, created_at: '2026-09-15T12:00:00Z', updated_at: '2026-09-15T12:00:00Z' }] };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const db = { connect: async () => client };
    const events = [];
    const pusher = { trigger: async (...args) => events.push(args) };
    const document = {
      id: 77,
      owner_type: 'person',
      owner_id: 5,
      folder_section: 'client_uploaded',
      folder_category: 'organizer',
      document_folder_id: null,
      folder_subcategory: '',
      uploaded_by_type: 'client',
      uploaded_by_id: 5,
      display_name: 'W-2.pdf',
      year: '2025',
    };

    const result = await createDocumentUploadNotification({ firmId: 3, uploaderPersonId: 5, document, db, pusher });

    expect(result).toMatchObject({ id: 90, category: 'tax', recipientIds: [11, 12] });
    expect(calls.some(c => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
    expect(calls.find(c => c.sql.includes('FROM document_notification_routes')).params).toEqual([3, 'tax']);
    expect(calls.some(c => c.sql.includes('document_upload_notification_documents'))).toBe(true);
    expect(calls.filter(c => c.sql.includes('document_upload_notification_recipients')).length).toBe(2);
    expect(events).toEqual([['private-firm-3', 'document-upload-notification', { refresh: true }]]);
  });

  test('grouped follow-up uploads reset only the notification original recipients', async () => {
    const { createDocumentUploadNotification } = require('../../server/services/documentUploadNotifications');
    const calls = [];
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes('FROM document_notification_routes')) return { rows: [{ staff_user_id: 22 }] };
        if (sql.includes('FROM document_upload_notifications')) return { rows: [{ id: 90, file_count: 1 }] };
        if (sql.includes('UPDATE document_upload_notification_recipients')) return { rows: [{ staff_user_id: 11 }, { staff_user_id: 12 }] };
        if (sql.includes('UPDATE document_upload_notifications')) return { rows: [{ id: 90, file_count: 2 }] };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const events = [];
    const result = await createDocumentUploadNotification({
      firmId: 3,
      uploaderPersonId: 5,
      document: {
        id: 78, owner_type: 'person', owner_id: 5, folder_section: 'client_uploaded',
        folder_category: 'tax', uploaded_by_type: 'client', display_name: '1099.pdf', year: '2025',
      },
      db: { connect: async () => client },
      pusher: { trigger: async (...args) => events.push(args) },
    });

    expect(result.recipientIds).toEqual([11, 12]);
    expect(calls.some(call => call.sql.includes('FROM document_notification_routes'))).toBe(false);
    const recipientReset = calls.find(call => call.sql.includes('UPDATE document_upload_notification_recipients'));
    expect(recipientReset.params).toEqual([3, 90]);
    expect(recipientReset.sql).toContain('read_at = NULL');
    expect(recipientReset.sql).toContain('archived_at = NULL');
    expect(calls.some(call => call.sql.includes('INSERT INTO document_upload_notification_recipients'))).toBe(false);
    expect(events[0][2]).toEqual({ refresh: true });
  });

  test('grouping is concurrency-safe and duplicate document retries do not inflate counts', () => {
    const schema = readRepoFile('server/db.js');
    const service = readRepoFile('server/services/documentUploadNotifications.js');

    expect(schema).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_document_upload_notification_documents_unique');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('FROM document_upload_notification_documents dnrd');
    expect(service).toContain('if (existingDocumentRows[0])');
  });

  test('document notification router rejects global API tokens before every route', () => {
    const router = require('../../server/routes/document-notifications');
    const middleware = router.stack.find(layer => !layer.route)?.handle;
    expect(middleware).toBeDefined();

    let nextCalled = false;
    let response;
    middleware(
      { firm: { id: 3, isApiToken: true } },
      { status(code) { response = { code }; return this; }, json(body) { response.body = body; } },
      () => { nextCalled = true; }
    );
    expect(response).toEqual({ code: 403, body: { error: 'Staff authentication required' } });
    expect(nextCalled).toBe(false);

    middleware({ firm: { id: 3, userId: 11 } }, {}, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  test('staff-bound API tokens cannot obtain document upload inbox counts', async () => {
    const { pool } = require('../../server/db');
    const messagesRouter = require('../../server/routes/messages');
    const handler = messagesRouter.stack.find(layer => layer.route?.path === '/unread-count').route.stack[0].handle;
    const originalQuery = pool.query;
    let body;

    pool.query = async () => ({ rows: [{ unread_count: 4, task_count: 2, document_upload_count: 7 }] });
    try {
      await handler(
        { firm: { id: 3, userId: 11, isApiToken: true } },
        { json(value) { body = value; } }
      );
    } finally {
      pool.query = originalQuery;
    }

    expect(body).toEqual({ unread_count: 4, task_count: 2, document_upload_count: 0, total: 6 });
  });

  test('ordinary staff JWT unread totals retain document upload counts', async () => {
    const { pool } = require('../../server/db');
    const messagesRouter = require('../../server/routes/messages');
    const handler = messagesRouter.stack.find(layer => layer.route?.path === '/unread-count').route.stack[0].handle;
    const originalQuery = pool.query;
    let body;

    pool.query = async () => ({ rows: [{ unread_count: 4, task_count: 2, document_upload_count: 7 }] });
    try {
      await handler(
        { firm: { id: 3, userId: 11 } },
        { json(value) { body = value; } }
      );
    } finally {
      pool.query = originalQuery;
    }

    expect(body).toEqual({ unread_count: 4, task_count: 2, document_upload_count: 7, total: 13 });
  });

  test('routes expose only active accepted unarchived staff', () => {
    const api = readRepoFile('server/routes/document-notifications.js');
    const getRoutes = api.slice(api.indexOf("router.get('/routes'"), api.indexOf("router.put('/routes'"));

    expect(getRoutes).toContain('fu.accepted_at IS NOT NULL');
    expect(getRoutes).toContain('fu.archived_at IS NULL');
  });

  test('only owners and admins can change upload routing', () => {
    const api = readRepoFile('server/routes/document-notifications.js');

    expect(api).toContain("if (!['owner', 'admin'].includes(req.firm.role))");
    expect(api).toContain("return res.status(403).json({ error: 'Owner or admin access required' })");
  });

  test('route replacement is serialized per firm before deleting assignments', () => {
    const api = readRepoFile('server/routes/document-notifications.js');
    const begin = api.indexOf("await client.query('BEGIN')");
    const lock = api.indexOf('pg_advisory_xact_lock', begin);
    const deletion = api.indexOf('DELETE FROM document_notification_routes', begin);

    expect(lock).toBeGreaterThan(begin);
    expect(deletion).toBeGreaterThan(lock);
    expect(api.slice(lock, deletion)).toContain('[req.firm.id]');
  });

  test('document inserts durably enqueue idempotent notification work and start a retry worker', () => {
    const schema = readRepoFile('server/db.js');
    const service = readRepoFile('server/services/documentUploadNotifications.js');
    const index = readRepoFile('server/index.js');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS document_upload_notification_outbox');
    expect(schema).toContain('UNIQUE(firm_id, document_id)');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION enqueue_document_upload_notification()');
    expect(schema).toContain('CREATE TRIGGER documents_notification_outbox_trigger');
    expect(schema).toContain("NEW.uploaded_by_type = 'client'");
    expect(schema).toContain("NEW.folder_section = 'client_uploaded'");
    expect(schema).toContain("NEW.folder_category <> 'message_docs'");
    expect(service).toContain('async function processNextDocumentUploadNotification');
    expect(service).toContain('FOR UPDATE SKIP LOCKED');
    expect(service).toContain("status = 'pending'");
    expect(service).toContain("status = 'processing'");
    expect(service).toContain("status = 'processing' AND started_at < NOW() - INTERVAL '5 minutes'");
    expect(service).toContain('outbox.owner_type');
    expect(service).not.toContain('JOIN people uploader ON uploader.id = $3 AND uploader.firm_id = d.firm_id');
    expect(service).toContain('No active document notification recipients configured');
    expect(service).toContain('FROM document_upload_notification_documents');
    expect(service).not.toContain('setImmediate');
    expect(index).toContain('startDocumentUploadNotificationWorker(app)');
  });

  test('outbox snapshots immutable upload-time routing and qualification data', () => {
    const schema = readRepoFile('server/db.js');
    const service = readRepoFile('server/services/documentUploadNotifications.js');
    const outboxTable = schema.slice(
      schema.indexOf('CREATE TABLE IF NOT EXISTS document_upload_notification_outbox'),
      schema.indexOf('CREATE INDEX IF NOT EXISTS idx_document_upload_notification_outbox_pending')
    );
    const trigger = schema.slice(
      schema.indexOf('CREATE OR REPLACE FUNCTION enqueue_document_upload_notification()'),
      schema.indexOf('CREATE TRIGGER documents_notification_outbox_trigger')
    );
    const worker = service.slice(
      service.indexOf('async function processNextDocumentUploadNotification'),
      service.indexOf('let documentNotificationWorkerStarted')
    );

    for (const column of [
      'owner_type', 'owner_id', 'folder_category', 'document_folder_id',
      'folder_subcategory', 'year', 'display_name', 'uploaded_by_type', 'folder_section',
    ]) {
      expect(outboxTable).toContain(column);
      expect(trigger).toContain(`NEW.${column}`);
      expect(worker).toContain(`job.${column}`);
    }
    expect(worker).not.toContain('FROM documents d');
    expect(worker).toContain('document_id: Number(job.document_id)');
  });

  test('worker completes non-qualifying snapshots but retries eligible uploads without recipients', () => {
    const service = readRepoFile('server/services/documentUploadNotifications.js');
    const worker = service.slice(
      service.indexOf('async function processNextDocumentUploadNotification'),
      service.indexOf('let documentNotificationWorkerStarted')
    );

    const qualification = worker.indexOf('if (!qualifiesForNotification(job))');
    const completion = worker.indexOf("SET status = 'completed'", qualification);
    const noRecipients = worker.indexOf('No active document notification recipients configured');
    const retry = worker.indexOf("SET status = 'pending'", noRecipients);
    expect(qualification).toBeGreaterThan(-1);
    expect(completion).toBeGreaterThan(qualification);
    expect(noRecipients).toBeGreaterThan(completion);
    expect(retry).toBeGreaterThan(noRecipients);
  });

  function deferred() {
    let resolve;
    let markStarted;
    const promise = new Promise(done => { resolve = done; });
    const started = new Promise(done => { markStarted = done; });
    return { promise, resolve, started, markStarted };
  }

  function leaseRaceDb(outcomes) {
    const state = { status: 'pending', attempts: 0 };
    const gates = outcomes.map(() => deferred());
    let connectionCount = 0;
    const baseJob = {
      id: 41, firm_id: 3, document_id: 77, uploader_person_id: 5,
      owner_type: 'person', owner_id: 5, folder_category: 'tax',
      document_folder_id: null, folder_subcategory: '', year: '2025',
      display_name: 'W-2.pdf', uploaded_by_type: 'client', folder_section: 'client_uploaded',
    };

    function updateApplies(sql, params) {
      const hasFence = sql.includes('firm_id = $2')
        && sql.includes("status = 'processing'")
        && sql.includes('attempts =');
      const expectedAttempt = params[params.length - 1];
      return !hasFence || Number(expectedAttempt) === state.attempts;
    }

    const db = {
      async connect() {
        const connectionIndex = connectionCount++;
        if (connectionIndex % 2 === 0) {
          return {
            async query(sql) {
              if (sql.includes('UPDATE document_upload_notification_outbox outbox')) {
                state.status = 'processing';
                state.attempts += 1;
                return { rows: [{ ...baseJob, attempts: state.attempts }] };
              }
              return { rows: [] };
            },
            release() {},
          };
        }
        const attemptIndex = Math.floor(connectionIndex / 2);
        return {
          async query(sql) {
            if (sql === 'BEGIN') {
              gates[attemptIndex].markStarted();
              await gates[attemptIndex].promise;
              if (outcomes[attemptIndex] === 'failure') throw new Error(`attempt ${attemptIndex + 1} failed`);
            }
            if (sql.includes('FROM document_upload_notification_documents dnrd')) {
              return { rows: [{ notification_id: 90 }] };
            }
            return { rows: [] };
          },
          release() {},
        };
      },
      async query(sql, params = []) {
        if (sql.includes('FROM document_upload_notification_documents')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes("SET status = 'completed'")) {
          if (updateApplies(sql, params)) state.status = 'completed';
          return { rows: [], rowCount: updateApplies(sql, params) ? 1 : 0 };
        }
        if (sql.includes("SET status = 'pending'")) {
          if (updateApplies(sql, params)) state.status = 'pending';
          return { rows: [], rowCount: updateApplies(sql, params) ? 1 : 0 };
        }
        return { rows: [] };
      },
    };
    return { db, state, gates };
  }

  test('late success cannot complete a newer reclaimed outbox attempt', async () => {
    const { processNextDocumentUploadNotification } = require('../../server/services/documentUploadNotifications');
    const { db, state, gates } = leaseRaceDb(['success', 'failure']);
    const staleWorker = processNextDocumentUploadNotification({ db });
    await gates[0].started;
    const currentWorker = processNextDocumentUploadNotification({ db });

    gates[1].resolve();
    await expect(currentWorker).rejects.toThrow('attempt 2 failed');
    expect(state).toMatchObject({ status: 'pending', attempts: 2 });
    gates[0].resolve();
    await staleWorker;

    expect(state).toMatchObject({ status: 'pending', attempts: 2 });
  });

  test('late failure cannot retry a newer completed outbox attempt', async () => {
    const { processNextDocumentUploadNotification } = require('../../server/services/documentUploadNotifications');
    const { db, state, gates } = leaseRaceDb(['failure', 'success']);
    const staleWorker = processNextDocumentUploadNotification({ db });
    await gates[0].started;
    const currentWorker = processNextDocumentUploadNotification({ db });

    gates[1].resolve();
    await currentWorker;
    expect(state).toMatchObject({ status: 'completed', attempts: 2 });
    gates[0].resolve();
    await expect(staleWorker).rejects.toThrow('attempt 1 failed');

    expect(state).toMatchObject({ status: 'completed', attempts: 2 });
  });

  test('portal uploads rely on the durable document trigger rather than untracked scheduling', () => {
    const portal = readRepoFile('server/routes/portal.js');
    const organizer = readRepoFile('server/routes/organizer.js');
    expect(portal).not.toContain('scheduleDocumentUploadNotification');
    expect(organizer).not.toContain('scheduleDocumentUploadNotification');
    const itemUpload = organizer.slice(organizer.indexOf("router.post('/client/:year/upload-item/:itemId'"), organizer.indexOf("router.delete('/client/:year/upload-item/:itemId'"));
    const bulkUpload = organizer.slice(organizer.indexOf("router.post('/client/:year/bulk-upload'"), organizer.indexOf("router.delete('/client/:year/bulk-upload'"));
    expect(itemUpload).toContain('uploaded_by_type, uploaded_by_id');
    expect(bulkUpload).toContain('uploaded_by_type, uploaded_by_id');
  });

  test('submitted organizer workpaper records the portal person as uploader', () => {
    const organizer = readRepoFile('server/routes/organizer.js');
    const submit = organizer.slice(
      organizer.indexOf("router.post('/client/:year/submit'"),
      organizer.indexOf("router.post('/:personId/:year/reopen'")
    );

    expect(submit).toContain('uploaded_by_type, uploaded_by_id, folder_section, folder_category');
    expect(submit).toContain("'client', $8, 'client_uploaded', 'organizer'");
    expect(submit).toContain('bucket, s3Key, workpaperBuffer.length, personId');
  });

  test('staff API scopes list and mutations to firm plus logged-in recipient and manages routing IDs', () => {
    const api = readRepoFile('server/routes/document-notifications.js');
    const index = readRepoFile('server/index.js');
    const messages = readRepoFile('server/routes/messages.js');

    expect(index).toContain("app.use('/api/document-notifications', requireFirm, apiLimiter, documentNotificationsRouter)");
    expect(api).toContain('const staffUserId = req.firm.userId');
    expect(api).toContain('dnr.firm_id = $1 AND dnr.staff_user_id = $2');
    expect(api).toContain("router.put('/:id/read'");
    expect(api).toContain("router.put('/:id/archive'");
    expect(api).toContain("router.put('/:id/restore'");
    expect(api).toContain("router.get('/routes'");
    expect(api).toContain("router.put('/routes'");
    expect(api).toContain("category === 'tax' || category === 'bookkeeping' || category === 'other'");
    expect(api).toContain('fu.firm_id = $1');
    expect(api).toContain("/crm/${row.owner_type}/${row.owner_id}?tab=docs");
    expect(api).not.toContain('s3_key');
    expect(messages).toContain('document_upload_notification_recipients');
    expect(messages).toContain('document_upload_count');
    expect(messages).toContain('{ unread_count: 0, task_count: 0, document_upload_count: 0, total: 0 }');
  });

  test('staff API returns authoritative pagination metadata and Inbox exposes accessible load-more controls', () => {
    const api = readRepoFile('server/routes/document-notifications.js');
    const view = readRepoFile('server/views/messages.ejs');

    expect(api).toContain('COUNT(*)::int AS total');
    expect(api).toContain('const total = Number(countRows[0]?.total || 0)');
    expect(api).toContain('hasMore: offset + notifications.length < total');
    expect(view).toContain('documentNotificationTotals = { active: 0, archived: 0 }');
    expect(view).toContain('async function loadMoreDocumentNotifications(archived = false)');
    expect(view).toContain('aria-label="Load more active document upload notifications"');
    expect(view).toContain('aria-label="Load more archived document upload notifications"');
    expect(view).toContain('documentNotificationTotals.active');
    expect(view).toContain('documentNotificationTotals.archived');
  });

  test('document notification search is server-side, debounced, and paginates within the query', () => {
    const api = readRepoFile('server/routes/document-notifications.js');
    const view = readRepoFile('server/views/messages.ejs');

    expect(api).toContain("const search = String(req.query.search || '')");
    expect(api).toContain("ILIKE '%' || $5 || '%'");
    expect(api).toContain('d_search.display_name ILIKE');
    expect(api).toContain('EXISTS (SELECT 1');
    expect(view).toContain('documentNotificationSearchTimer = setTimeout');
    expect(view).toContain("params.set('search', search)");
    expect(view).toContain("params.set('offset', String(loadedCount))");
    expect(view).toContain('documentNotificationResultTotals');
    expect(view).not.toContain('if (q) notifications = notifications.filter');
    expect(view).not.toContain('archivedDocumentNotifications.filter(item => !q');
  });

  test('full Inbox refresh and notification pages fence each other with one generation', () => {
    const view = readRepoFile('server/views/messages.ejs');
    const inbox = view.slice(view.indexOf('async function loadInbox('), view.indexOf('function renderSmsExceptions'));
    const page = view.slice(view.indexOf('async function loadDocumentNotificationPage('), view.indexOf('async function loadMoreDocumentNotifications'));

    expect(view).toContain('let inboxRequestGeneration = 0');
    expect(inbox).toContain('const requestGeneration = ++inboxRequestGeneration');
    expect(inbox).toContain('clearTimeout(documentNotificationSearchTimer)');
    expect(page).toContain('const requestGeneration = ++inboxRequestGeneration');
    expect(inbox).toContain('if (requestGeneration !== inboxRequestGeneration) return');
    expect(page).toContain('requestGeneration !== inboxRequestGeneration');
    expect(view).not.toContain('documentNotificationRequestIds');
  });

  test('searched Inbox refresh never commits an unfiltered notification response', async () => {
    const view = readRepoFile('server/views/messages.ejs');
    const loadInboxSource = view.slice(
      view.indexOf('async function loadInbox('),
      view.indexOf('function renderSmsExceptions')
    );
    const gates = new Map();
    const requests = [];
    const renderedActiveIds = [];
    const response = body => ({ ok: true, json: async () => body });
    const deferredResponse = (url, body) => {
      let resolve;
      const promise = new Promise(done => { resolve = () => done(response(body)); });
      gates.set(url, resolve);
      return promise;
    };
    const context = {
      inboxRequestGeneration: 0,
      documentNotificationSearchTimer: null,
      documentNotificationRequestedQueries: { active: 'W-2', archived: '' },
      documentNotificationQueries: { active: 'W-2', archived: '' },
      documentNotificationTotals: { active: 7, archived: 0 },
      documentNotificationResultTotals: { active: 1, archived: 0 },
      documentNotifications: [{ id: 1, summary: 'W-2' }],
      archivedDocumentNotifications: [],
      allThreads: [],
      archivedThreads: [],
      activeThreadId: null,
      activeTab: 'documents',
      clearTimeout() {},
      document: {
        getElementById(id) {
          if (id === 'searchBox') return { value: 'W-2' };
          return { innerHTML: '' };
        },
      },
      window: {},
      renderSmsExceptions() {},
      threadsForActiveTab: () => [],
      loadThread() {},
      filterThreads() {},
      renderInbox() {
        renderedActiveIds.push(context.documentNotifications.map(item => item.id));
      },
      apiFetch(url) {
        requests.push(url);
        if (url === '/api/messages' || url === '/api/messages?view=archived') return Promise.resolve(response([]));
        if (url === '/api/messages/sms-exceptions') return Promise.resolve(response([]));
        if (url.includes('archived=true')) return deferredResponse(url, { notifications: [], total: 0 });
        if (url.includes('search=W-2')) return deferredResponse(url, { notifications: [{ id: 1, summary: 'W-2' }], total: 1 });
        return deferredResponse(url, { notifications: [{ id: 999, summary: 'Unrelated 1099' }], total: 7 });
      },
    };
    vm.runInNewContext(`${loadInboxSource}; this.loadInbox = loadInbox;`, context);

    const refresh = context.loadInbox(false);
    await new Promise(resolve => setImmediate(resolve));
    for (const resolve of gates.values()) resolve();
    await refresh;

    expect(requests).toContain('/api/document-notifications?search=W-2');
    expect(renderedActiveIds).not.toContainEqual([999]);
    expect(context.documentNotifications.map(item => item.id)).toEqual([1]);
    expect(context.documentNotificationQueries.active).toBe('W-2');
  });

  test('notification page commits only to the current query and current arrays', () => {
    const view = readRepoFile('server/views/messages.ejs');
    const page = view.slice(view.indexOf('async function loadDocumentNotificationPage('), view.indexOf('async function loadMoreDocumentNotifications'));

    expect(view).toContain("let documentNotificationRequestedQueries = { active: '', archived: '' }");
    expect(page).toContain('documentNotificationRequestedQueries[key] = search');
    expect(page).toContain('documentNotificationRequestedQueries[key] !== search');
    expect(page).not.toContain('const current = archived ? archivedDocumentNotifications : documentNotifications');
    expect(page).toContain('const currentNotifications = archived ? archivedDocumentNotifications : documentNotifications');
    expect(page).toContain('documentNotifications = nextNotifications');
    expect(page).toContain('archivedDocumentNotifications = nextNotifications');
  });

  test('Archived upload-only state clears stale message detail and shows the upload placeholder', () => {
    const view = readRepoFile('server/views/messages.ejs');
    expect(view).toContain("if (activeTab === 'archived' && !threads.length && archivedUploads.length)");
    expect(view).toContain('clearThreadPanel();');
    expect(view).toContain('Archived upload alerts open the related client documents.');
  });

  test('Inbox tabs use a two-column layout so every option remains visible', () => {
    const view = readRepoFile('server/views/messages.ejs');
    const tabStyles = view.slice(view.indexOf('.inbox-tabs {'), view.indexOf('.inbox-tab:hover'));

    expect(tabStyles).toContain('display: grid');
    expect(tabStyles).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(tabStyles).toContain('min-width: 0');
    expect(tabStyles).toContain('white-space: normal');
    expect(tabStyles).toContain('flex-wrap: wrap');
  });

  test('Inbox renders a separate Docs tab with read archive restore and recipient Pusher refresh', () => {
    const view = readRepoFile('server/views/messages.ejs');

    expect(view).toContain('id="tabDocumentUploads"');
    expect(view).toContain('📄 Docs');
    expect(view).toContain('DOCUMENT UPLOAD');
    expect(view).toContain("apiFetch('/api/document-notifications')");
    expect(view).toContain("apiFetch('/api/document-notifications?archived=true')");
    expect(view).toContain("_firmChannel.bind('document-upload-notification'");
    expect(view).toContain("_firmChannel.bind('document-upload-notification', () => loadInbox(false))");
    expect(view).not.toContain('recipientIds.map(Number).includes(Number(_myUserId))');
    expect(view).toContain("`/api/document-notifications/${notification.id}/read`");
    expect(view).toContain("`/api/document-notifications/${notificationId}/archive`");
    expect(view).toContain("`/api/document-notifications/${notificationId}/restore`");
    expect(view).toContain('window.location.href = notification.target');
    expect(view).toContain('Open Documents');
  });

  test('Settings configures Tax Bookkeeping and Other routes with firm staff IDs', () => {
    const view = readRepoFile('server/views/settings.ejs');

    expect(view).toContain("switchTab('document-notifications')");
    expect(view).toContain('id="tab-document-notifications"');
    expect(view).toContain('data-route-category="tax"');
    expect(view).toContain('data-route-category="bookkeeping"');
    expect(view).toContain('data-route-category="other"');
    expect(view).toContain("apiFetch('/api/staff')");
    expect(view).toContain("apiFetch('/api/document-notifications/routes')");
    expect(view).toContain("method: 'PUT'");
    expect(view).toContain('Save Upload Routing');
  });

  test('durable trigger covers specialized tax-financial and statement document inserts', () => {
    const portal = readRepoFile('server/routes/portal.js');
    const financials = portal.slice(portal.indexOf("router.post('/companies/:id/tax-financials'"), portal.indexOf("router.get('/documents'"));
    const statements = portal.slice(portal.indexOf("router.post('/companies/:id/statements/:scheduleId/:month'"), portal.indexOf("router.get('/bookkeeping-questions'"));
    expect(financials).toContain("'client_uploaded', 'tax'");
    expect(financials).toContain("'client'");
    expect(statements).toContain("'client_uploaded', 'bookkeeping'");
    expect(statements).toContain("'client'");
  });

  test('notification targets activate the Docs tab for person and company records', () => {
    for (const viewName of ['crm-person.ejs', 'crm-company.ejs']) {
      const view = readRepoFile(`server/views/${viewName}`);
      expect(view).toContain("new URLSearchParams(window.location.search).get('tab')");
      expect(view).toContain("requestedTab === 'docs'");
      expect(view).toContain("switchTab('docs'");
    }
  });
});
