// tests/e2e/portal-statements.spec.js
// Tests: Bookkeeping statement upload flow
//   - GET /portal/companies/:id/statements — returns account list + monthly status
//   - POST /portal/companies/:id/statements/:scheduleId/:month — uploads a statement
//   - Document is saved with correct folder_subcategory (account name)
//   - Documents API returns folder_subcategory field
//   - Advisor view: /api/documents returns folder_subcategory
//   - Portal overview: statements card logic (pending count)

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { BASE_URL, TIMEOUTS } = require('./helpers/config');

// These tests need an authenticated portal session for company access.
// We use the staff auth state to hit advisor APIs, and a portal token
// for portal-side endpoints.
test.use({ storageState: 'tests/.auth/user.json' });

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getStaffToken(page) {
  await page.goto(`${BASE_URL}/dashboard`, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUTS.navigation,
  });
  return page.evaluate(() => localStorage.getItem('dl_token'));
}

async function getPortalToken(page, staffToken) {
  // Find a person with portal access via people API
  const res = await page.request.get(`${BASE_URL}/api/people`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  });
  if (!res.ok()) return null;
  const data = await res.json();
  const people = Array.isArray(data) ? data : data.people || [];
  const portalPerson = people.find(p => p.portal_enabled && p.portal_has_password);
  if (!portalPerson) return null;

  // Get a preview token — this IS the portal token (stored directly as portalToken)
  const previewRes = await page.request.post(
    `${BASE_URL}/api/people/${portalPerson.id}/portal-preview`,
    { headers: { Authorization: `Bearer ${staffToken}` } }
  );
  if (!previewRes.ok()) return null;
  const { url } = await previewRes.json();
  if (!url) return null;

  // Extract the preview_token from URL — it is used directly as the portal Bearer token
  const previewToken = new URL(url).searchParams.get('preview_token');
  return previewToken || null;
}

async function getClientUploadCompany(page, portalToken) {
  const res = await page.request.get(`${BASE_URL}/portal/companies`, {
    headers: { Authorization: `Bearer ${portalToken}` },
  });
  if (!res.ok()) return null;
  const companies = await res.json();
  // Return first company that has client_upload schedules
  for (const co of companies) {
    const coId = co.id || co.company_id;
    const stmtRes = await page.request.get(
      `${BASE_URL}/portal/companies/${coId}/statements`,
      { headers: { Authorization: `Bearer ${portalToken}` } }
    );
    if (!stmtRes.ok()) continue;
    const data = await stmtRes.json();
    if (data.accounts && data.accounts.length > 0) return { company: co, stmtData: data };
  }
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Bookkeeping Statements — API', () => {

  test('GET /portal/companies/:id/statements without auth returns 401', async ({ page }) => {
    const res = await page.request.get(`${BASE_URL}/portal/companies/1/statements`);
    expect(res.status()).toBe(401);
  });

  test('portal token cannot access staff APIs', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const res = await page.request.get(`${BASE_URL}/api/staff`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /portal/companies/:id/statements for unknown company returns 403 or empty', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const res = await page.request.get(`${BASE_URL}/portal/companies/999999/statements`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect([403, 404]).toContain(res.status());
  });

  test('GET /portal/companies/:id/statements returns accounts array', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const companies = await (await page.request.get(`${BASE_URL}/portal/companies`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    })).json();

    if (!companies.length) return test.skip(true, 'No companies for portal user');
    const coId = companies[0].id || companies[0].company_id;

    const res = await page.request.get(`${BASE_URL}/portal/companies/${coId}/statements`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('accounts');
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body).toHaveProperty('total_pending');
    expect(typeof body.total_pending).toBe('number');
  });

  test('GET /portal/companies/:id/statements — accounts have expected shape', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const result = await getClientUploadCompany(page, portalToken);
    if (!result) return test.skip(true, 'No company with client_upload schedules found');

    const { stmtData } = result;
    expect(stmtData.accounts.length).toBeGreaterThan(0);

    const acct = stmtData.accounts[0];
    expect(acct).toHaveProperty('id');
    expect(acct).toHaveProperty('account_name');
    expect(acct).toHaveProperty('months');
    expect(Array.isArray(acct.months)).toBe(true);

    if (acct.months.length > 0) {
      const m = acct.months[0];
      expect(m).toHaveProperty('month');
      expect(m).toHaveProperty('status');
      expect(m.month).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  test('POST /portal/companies/:id/statements/:scheduleId/:month without auth returns 401', async ({ page }) => {
    const res = await page.request.post(
      `${BASE_URL}/portal/companies/1/statements/1/2026-01`,
      { multipart: { file: { name: 'test.pdf', mimeType: 'application/pdf', buffer: Buffer.from('test') } } }
    );
    expect(res.status()).toBe(401);
  });

  test('POST upload — invalid month format returns 400', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const result = await getClientUploadCompany(page, portalToken);
    if (!result) return test.skip(true, 'No company with client_upload schedules found');

    const { company, stmtData } = result;
    const coId = company.id || company.company_id;
    const scheduleId = stmtData.accounts[0].id;

    const res = await page.request.post(
      `${BASE_URL}/portal/companies/${coId}/statements/${scheduleId}/not-a-month`,
      {
        headers: { Authorization: `Bearer ${portalToken}` },
        multipart: {
          file: { name: 'test.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') },
        },
      }
    );
    expect([400, 422]).toContain(res.status());
  });

  test('POST upload — valid PDF returns ok:true and document_id', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const result = await getClientUploadCompany(page, portalToken);
    if (!result) return test.skip(true, 'No company with client_upload schedules found');

    const { company, stmtData } = result;
    const coId = company.id || company.company_id;

    // Find a pending month to upload
    let targetAccount = null;
    let targetMonth = null;
    for (const acct of stmtData.accounts) {
      const pending = acct.months.find(m => !['uploaded', 'received'].includes(m.status));
      if (pending) { targetAccount = acct; targetMonth = pending.month; break; }
    }
    if (!targetAccount) return test.skip(true, 'No pending months available to upload');

    // Minimal valid PDF bytes
    const pdfBytes = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
      'xref\n0 4\n0000000000 65535 f\ntrailer<</Root 1 0 R/Size 4>>\nstartxref\n0\n%%EOF'
    );

    const res = await page.request.post(
      `${BASE_URL}/portal/companies/${coId}/statements/${targetAccount.id}/${targetMonth}`,
      {
        headers: { Authorization: `Bearer ${portalToken}` },
        multipart: {
          file: { name: `${targetAccount.account_name}-${targetMonth}.pdf`, mimeType: 'application/pdf', buffer: pdfBytes },
        },
      }
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('document_id');
    expect(typeof body.document_id).toBe('number');
  });

  test('POST upload — statement_monthly_status updated to uploaded after upload', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const result = await getClientUploadCompany(page, portalToken);
    if (!result) return test.skip(true, 'No company with client_upload schedules found');

    const { company, stmtData } = result;
    const coId = company.id || company.company_id;

    let targetAccount = null;
    let targetMonth = null;
    for (const acct of stmtData.accounts) {
      const pending = acct.months.find(m => !['uploaded', 'received'].includes(m.status));
      if (pending) { targetAccount = acct; targetMonth = pending.month; break; }
    }
    if (!targetAccount) return test.skip(true, 'No pending months available');

    const pdfBytes = Buffer.from('%PDF-1.4 minimal test pdf content for e2e');
    await page.request.post(
      `${BASE_URL}/portal/companies/${coId}/statements/${targetAccount.id}/${targetMonth}`,
      {
        headers: { Authorization: `Bearer ${portalToken}` },
        multipart: {
          file: { name: 'stmt.pdf', mimeType: 'application/pdf', buffer: pdfBytes },
        },
      }
    );

    // Re-fetch statements — month should now be 'uploaded'
    const refreshRes = await page.request.get(
      `${BASE_URL}/portal/companies/${coId}/statements`,
      { headers: { Authorization: `Bearer ${portalToken}` } }
    );
    const refreshed = await refreshRes.json();
    const updatedAcct = refreshed.accounts.find(a => a.id === targetAccount.id);
    expect(updatedAcct).toBeTruthy();
    const updatedMonth = updatedAcct.months.find(m => m.month === targetMonth);
    expect(updatedMonth).toBeTruthy();
    expect(['uploaded', 'received']).toContain(updatedMonth.status);
  });

});

test.describe('Bookkeeping Statements — Document Storage', () => {

  test('Uploaded statement document has folder_subcategory set to account name', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const result = await getClientUploadCompany(page, portalToken);
    if (!result) return test.skip(true, 'No company with client_upload schedules found');

    const { company, stmtData } = result;
    const coId = company.id || company.company_id;

    let targetAccount = null;
    let targetMonth = null;
    for (const acct of stmtData.accounts) {
      const pending = acct.months.find(m => !['uploaded', 'received'].includes(m.status));
      if (pending) { targetAccount = acct; targetMonth = pending.month; break; }
    }
    if (!targetAccount) return test.skip(true, 'No pending months available');

    const pdfBytes = Buffer.from('%PDF-1.4 subcategory test');
    const uploadRes = await page.request.post(
      `${BASE_URL}/portal/companies/${coId}/statements/${targetAccount.id}/${targetMonth}`,
      {
        headers: { Authorization: `Bearer ${portalToken}` },
        multipart: {
          file: { name: 'stmt.pdf', mimeType: 'application/pdf', buffer: pdfBytes },
        },
      }
    );
    expect(uploadRes.status()).toBe(200);
    const { document_id } = await uploadRes.json();

    // Verify via advisor documents API that folder_subcategory = account_name
    const docsRes = await page.request.get(
      `${BASE_URL}/api/documents?owner_type=company&owner_id=${coId}`,
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    expect(docsRes.status()).toBe(200);
    const docs = await docsRes.json();
    const uploadedDoc = docs.find(d => d.id === document_id);
    expect(uploadedDoc).toBeTruthy();
    expect(uploadedDoc.folder_subcategory).toBe(targetAccount.account_name);
    expect(uploadedDoc.folder_category).toBe('bookkeeping');
    expect(uploadedDoc.folder_section).toBe('client_uploaded');
  });

  test('GET /api/documents returns folder_subcategory field on all documents', async ({ page }) => {
    const staffToken = await getStaffToken(page);

    const docsRes = await page.request.get(
      `${BASE_URL}/api/documents?owner_type=company&owner_id=2`,
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    if (!docsRes.ok()) return test.skip(true, 'No company docs accessible');
    const docs = await docsRes.json();
    if (!docs.length) return test.skip(true, 'No documents found');

    // Every document should have folder_subcategory key (may be null/empty but must exist)
    docs.forEach(doc => {
      expect(doc).toHaveProperty('folder_subcategory');
    });
  });

  test('Portal GET /portal/documents returns folder_subcategory field', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const res = await page.request.get(`${BASE_URL}/portal/documents`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    if (!res.ok()) return test.skip(true, 'Portal docs fetch failed');
    const docs = await res.json();
    if (!docs.length) return test.skip(true, 'No portal documents found');

    docs.forEach(doc => {
      expect(doc).toHaveProperty('folder_subcategory');
    });
  });

});

test.describe('Bookkeeping Statements — Overview Card', () => {

  test('GET /portal/companies/:id/statements returns total_pending count', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const result = await getClientUploadCompany(page, portalToken);
    if (!result) return test.skip(true, 'No company with client_upload schedules found');

    const { stmtData } = result;
    // total_pending should match count of pending months across all accounts
    let manualCount = 0;
    for (const acct of stmtData.accounts) {
      manualCount += acct.months.filter(m => !['uploaded', 'received'].includes(m.status)).length;
    }
    expect(stmtData.total_pending).toBe(manualCount);
  });

  test('GET /portal/companies/:id/statements — company with no client_upload schedules returns empty accounts', async ({ page }) => {
    const staffToken = await getStaffToken(page);
    const portalToken = await getPortalToken(page, staffToken);
    if (!portalToken) return test.skip(true, 'No portal user available');

    const companies = await (await page.request.get(`${BASE_URL}/portal/companies`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    })).json();

    // Find a company that has NO client_upload schedules by checking statements endpoint
    for (const co of companies) {
      const coId = co.id || co.company_id;
      const res = await page.request.get(`${BASE_URL}/portal/companies/${coId}/statements`, {
        headers: { Authorization: `Bearer ${portalToken}` },
      });
      if (!res.ok()) continue;
      const body = await res.json();
      if (body.accounts && body.accounts.length === 0) {
        expect(res.status()).toBe(200);
        expect(body.accounts).toHaveLength(0);
        // total_pending should be 0 or absent when accounts is empty
        expect(body.total_pending === 0 || body.total_pending === undefined).toBeTruthy();
        return;
      }
    }
    // All companies have client_upload schedules — skip rather than fail
    test.skip(true, 'All accessible companies have client_upload schedules; cannot test empty case');
  });

});
