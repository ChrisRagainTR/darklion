'use strict';

const { test, expect } = require('@playwright/test');
const express = require('express');
const {
  AgentDocumentError,
  createClientDocumentFolder,
  getDocument,
  getDocumentDownloadUrl,
  listDocuments,
  trashDocument,
  updateDocument,
} = require('../../server/services/agentDocuments');
const { createAgentWorkDocumentsRouter } = require('../../server/routes/agent-work-documents');

const row = {
  id: 41,
  firm_id: 7,
  owner_type: 'company',
  owner_id: 9,
  relationship_id: 3,
  relationship_name: 'Example Household',
  company_id: 9,
  company_name: 'Example LLC',
  display_name: '2025 Return.pdf',
  year: '2025',
  doc_type: 'tax',
  folder_section: 'firm_uploaded',
  folder_category: 'tax',
  document_folder_id: null,
  folder_subcategory: '',
  mime_type: 'application/pdf',
  size_bytes: '1234',
  uploaded_by_type: 'staff',
  is_delivered: false,
  created_at: '2026-01-01T00:00:00.000Z',
  s3_key: 'secret-key',
  s3_bucket: 'secret-bucket',
  deleted_by: 99,
};

test.describe('Agent Work document service', () => {
  test('lists only firm-scoped, staff-visible documents and allowlists response fields', async () => {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [row] }; } };
    const result = await listDocuments({
      firmId: 7,
      staffUserId: 11,
      filters: { relationship_id: 3, deleted: 'active', limit: 20 },
      db,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('d.firm_id = $1');
    expect(calls[0].sql).toContain('firm_user_companies');
    expect(calls[0].params).toContain(7);
    expect(calls[0].params).toContain(11);
    expect(result.pagination).toEqual({ limit: 20, offset: 0, count: 1 });
    expect(result.documents[0]).toMatchObject({ id: 41, company_id: 9, display_name: '2025 Return.pdf', size_bytes: 1234 });
    for (const sensitive of ['firm_id', 's3_key', 's3_bucket', 'deleted_by']) {
      expect(result.documents[0]).not.toHaveProperty(sensitive);
    }
  });

  test('gets a document with strict firm and staff company-access predicates', async () => {
    let captured;
    const db = { query: async (sql, params) => { captured = { sql, params }; return { rows: [row] }; } };
    const result = await getDocument({ firmId: 7, staffUserId: 11, documentId: 41, db });
    expect(captured.sql).toContain('d.id = $1 AND d.firm_id = $2');
    expect(captured.sql).toContain('allowed.realm_id = c.realm_id');
    expect(captured.params.slice(0, 3)).toEqual([41, 7, 11]);
    expect(result).not.toHaveProperty('s3_key');
  });

  test('creates client folders only after verifying the owner in the same firm', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      return { rows: [{ id: 8, scope: 'client', applies_to: 'person', owner_type: 'person', owner_id: 22, folder_section: 'firm_uploaded', folder_category: 'tax', name: 'Returns' }] };
    } };
    const folder = await createClientDocumentFolder({
      firmId: 7, staffUserId: 11,
      input: { owner_type: 'person', owner_id: 22, name: ' Returns ', folder_section: 'firm_uploaded', folder_category: 'tax' },
      db,
    });
    expect(calls[0].sql).toContain('firm_id = $2');
    expect(calls[1].sql).toContain("VALUES ($1, 'client'");
    expect(calls[1].params).toEqual([7, 'person', 22, 'firm_uploaded', 'tax', 'Returns', 11]);
    expect(folder).toMatchObject({ scope: 'client', owner_id: 22, name: 'Returns' });
  });

  test('updates metadata without permitting delivery state or storage fields', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE documents')) return { rows: [{ ...row, display_name: 'Renamed.pdf' }] };
      return { rows: [{ ...row, display_name: calls.some(call => call.sql.startsWith('UPDATE documents')) ? 'Renamed.pdf' : row.display_name }] };
    } };
    const updated = await updateDocument({
      firmId: 7, staffUserId: 11, documentId: 41,
      input: { display_name: 'Renamed.pdf', is_delivered: true, s3_key: 'attacker' },
      db,
    });
    const update = calls.find(call => call.sql.startsWith('UPDATE documents'));
    expect(update.sql).toContain('display_name = $1');
    expect(update.sql).not.toContain('is_delivered');
    expect(update.sql).not.toContain('s3_key');
    expect(updated.display_name).toBe('Renamed.pdf');
  });

  test('refuses to trash documents attached to a tax delivery and never permanently deletes', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM tax_deliveries')) return { rows: [{ id: 5, status: 'sent', title: '2025 return' }] };
      return { rows: [row] };
    } };
    await expect(trashDocument({ firmId: 7, staffUserId: 11, documentId: 41, db })).rejects.toMatchObject({
      status: 409, code: 'document_in_use',
    });
    expect(calls.some(call => /DELETE FROM documents/i.test(call.sql))).toBe(false);
    expect(calls.some(call => /UPDATE documents SET deleted_at/i.test(call.sql))).toBe(false);
  });

  test('creates a short-lived signed URL without exposing storage coordinates', async () => {
    const db = { query: async sql => sql.includes('SELECT display_name, s3_key')
      ? { rows: [row] }
      : { rows: [row] } };
    let signed;
    const result = await getDocumentDownloadUrl({
      firmId: 7, staffUserId: 11, documentId: 41, db,
      signer: async input => { signed = input; return 'https://signed.example/document'; },
    });
    expect(signed).toMatchObject({ key: 'secret-key', bucket: 'secret-bucket', filename: '2025 Return.pdf', expiresIn: 900 });
    expect(result).toEqual({ document_id: 41, display_name: '2025 Return.pdf', url: 'https://signed.example/document', expires_in_seconds: 900 });
  });

  test('rejects invalid owners before constructing document queries', async () => {
    await expect(listDocuments({ firmId: 7, filters: { owner_type: 'firm', owner_id: 1 }, db: { query: async () => ({ rows: [] }) } }))
      .rejects.toBeInstanceOf(AgentDocumentError);
  });
});

test.describe('Agent Work documents router', () => {
  async function withServer(capabilities, service, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.agentFirmId = 7;
      req.agentStaffUserId = 11;
      req.agentConnection = { id: 2, capabilities };
      next();
    });
    app.use('/documents', createAgentWorkDocumentsRouter({ service, audit: async () => {} }));
    const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    try { await callback(`http://127.0.0.1:${listener.address().port}`); }
    finally { await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
  }

  test('passes authenticated firm/staff scope to reads', async () => {
    let args;
    await withServer({ documents_read: true }, {
      listDocuments: async input => { args = input; return { documents: [], pagination: { limit: 50, offset: 0, count: 0 } }; },
    }, async base => {
      const response = await fetch(`${base}/documents?relationship_id=3`);
      expect(response.status).toBe(200);
      expect(args).toMatchObject({ firmId: 7, staffUserId: 11, filters: { relationship_id: '3' } });
    });
  });

  test('enforces distinct read and write capabilities', async () => {
    await withServer({ documents_read: true, documents_write: false }, {
      updateDocument: async () => { throw new Error('must not run'); },
    }, async base => {
      const response = await fetch(`${base}/documents/41`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: 'x.pdf' }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'capability_disabled' });
    });
  });

  test('has no permanent-delete route', async () => {
    await withServer({ documents_write: true }, {}, async base => {
      const response = await fetch(`${base}/documents/41/permanent`, { method: 'DELETE' });
      expect(response.status).toBe(404);
    });
  });
});
