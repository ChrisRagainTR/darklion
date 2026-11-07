'use strict';

const { test, expect } = require('@playwright/test');
const express = require('express');
const fs = require('fs');
const path = require('path');
const business = require('../../server/services/agentBusinessRecords');
const { createAgentWorkBusinessRouter } = require('../../server/routes/agent-work-business');

test.describe('Agent Work business record service', () => {
  test('bookkeeping reads apply staff company access and omit realms, account IDs, and error blobs', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{
        id: 8, company_id: 4, company_name: 'Example Co', realm_id: 'secret-realm',
        vendor_name: 'Vendor', direction: 'expense', account_name: 'Office Supplies',
        account_id: 'provider-account', source: 'manual', confidence: 99, usage_count: 4,
        min_amount: '10.50', max_amount: '99.75', error_message: 'internal stack',
      }] };
    } };
    const result = await business.listBookkeepingMappings({ firmId: 7, staffUserId: 11, search: 'Vendor', limit: 20, db });
    expect(calls[0].sql).toContain('firm_user_companies');
    expect(calls[0].sql).toContain('vm.firm_id = $1');
    expect(calls[0].params).toEqual([7, 11, '%Vendor%', 20]);
    expect(result.mappings[0]).toMatchObject({ company_id: 4, vendor_name: 'Vendor', minimum_amount: 10.5 });
    for (const key of ['realm_id', 'account_id', 'error_message']) expect(result.mappings[0]).not.toHaveProperty(key);
  });

  test('tax delivery detail verifies firm and company access and allowlists signer data', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT tds.id')) return { rows: [{
        id: 3, delivery_id: 9, person_id: 22, person_name: 'Pat Client', signer_role: 'taxpayer',
        approved_at: '2026-01-01', approved_ip: '10.0.0.1', signed_at: '2026-01-02', signed_ip: '10.0.0.2',
        signature_data: 'base64-secret', signature_type: 'drawn', needs_changes_note: '',
      }] };
      return { rows: [{
        id: 9, firm_id: 7, company_id: 4, company_name: 'Example Co', tax_year: '2025',
        title: '2025 Return', intro_note: 'Review', tax_summary: { wages: 1 }, status: 'sent',
        tax_report_error: 'internal prompt', public_token: 'secret', s3_key: 'secret-key',
      }] };
    } };
    const delivery = await business.getTaxDelivery({ firmId: 7, staffUserId: 11, deliveryId: 9, db });
    expect(calls[0].sql).toContain('td.id = $1 AND td.firm_id = $2');
    expect(calls[0].sql).toContain('firm_user_companies');
    expect(calls[0].params).toEqual([9, 7, 11]);
    expect(delivery).toMatchObject({ id: 9, company_id: 4, tax_year: '2025' });
    for (const key of ['firm_id', 'tax_report_error', 'public_token', 's3_key']) expect(delivery).not.toHaveProperty(key);
    for (const key of ['approved_ip', 'signed_ip', 'signature_data']) expect(delivery.signers[0]).not.toHaveProperty(key);
  });

  test('generated tax summary returns normalized tax facts and only an error flag', async () => {
    const db = { query: async sql => {
      if (sql.includes('SELECT tds.id')) return { rows: [] };
      if (sql.startsWith('SELECT tax_report_data')) return { rows: [{
        tax_report_status: 'completed', tax_report_error: 'provider stack and prompt', has_error: true,
        tax_report_data: { client: { names: 'Pat Client', form_type: '1040' }, adjusted_gross_income: 123456, raw_provider_response: 'secret' },
      }] };
      return { rows: [{ id: 9, company_id: null, tax_year: '2025', status: 'sent' }] };
    } };
    const summary = await business.getTaxDeliverySummary({ firmId: 7, staffUserId: 11, deliveryId: 9, db });
    expect(summary).toEqual({
      delivery_id: 9,
      status: 'completed',
      data: {
        adjusted_gross_income: 123456, taxable_income: null, total_tax: null,
        total_payments: null, refund_or_balance_due: null, filing_status: null,
        tax_year: null, form_type: '1040', client_name: 'Pat Client',
      },
      has_error: true,
    });
    expect(JSON.stringify(summary)).not.toContain('provider stack');
    expect(JSON.stringify(summary)).not.toContain('raw_provider_response');
  });

  test('organizer detail verifies person access and omits storage coordinates, EINs, account numbers, and answer details', async () => {
    const db = { query: async sql => {
      if (sql.includes('SELECT p.id')) return { rows: [{ id: 22 }] };
      if (sql.includes('FROM tax_organizer_items')) return { rows: [{
        id: 31, organizer_id: 14, section: '1099-int', payer_name: 'Bank', account_number: '123456',
        ein: '12-3456789', owner: 'taxpayer', status: 'pending', s3_key: 'secret-key',
      }] };
      return { rows: [{
        id: 14, person_id: 22, tax_year: '2025', status: 'in_progress',
        question_answers: { q1: { answer: true, details: 'Private details' }, q17: { details: 'Concern' } },
        workpaper_key: 'secret-key', workpaper_bucket: 'secret-bucket',
      }] };
    } };
    const organizer = await business.getOrganizer({ firmId: 7, staffUserId: 11, personId: 22, year: '2025', db });
    expect(organizer.answers.q1).toEqual({ answer: true, details_provided: true });
    expect(organizer.answers.q17).toEqual({ answered: true });
    expect(organizer.items[0]).not.toHaveProperty('account_number');
    expect(organizer.items[0]).not.toHaveProperty('ein');
    expect(organizer).not.toHaveProperty('workpaper_key');
    expect(JSON.stringify(organizer)).not.toContain('Private details');
  });

  test('proposal detail uses relationship access and excludes public, invite, signature, and IP material', async () => {
    const db = { query: async sql => {
      if (sql.includes('FROM proposal_acceptances')) return { rows: [{ contact_name: 'Pat', contact_email: 'private@example.com', accepted_at: '2026-01-01' }] };
      if (sql.includes('FROM proposal_engagements')) return { rows: [{
        status: 'signed', signed_by_name: 'Pat', signed_at: '2026-01-02', signature_data: 'signature', signer_ip: '10.0.0.1', monthly_price: '500',
      }] };
      return { rows: [{
        id: 6, relationship_id: 3, relationship_name: 'Client', title: 'Proposal', status: 'signed',
        public_token: 'public-secret', primary_person_portal_invite_token: 'invite-secret', portal_password_hash: 'hash',
      }] };
    } };
    const proposal = await business.getProposal({ firmId: 7, staffUserId: 11, proposalId: 6, db });
    expect(proposal).toMatchObject({ id: 6, relationship_id: 3, engagement: { status: 'signed', monthly_price: 500 } });
    for (const forbidden of ['public_token', 'primary_person_portal_invite_token', 'portal_password_hash', 'signature_data', 'signer_ip', 'contact_email']) {
      expect(JSON.stringify(proposal)).not.toContain(forbidden === 'contact_email' ? 'private@example.com' : forbidden.includes('token') ? forbidden.split('_')[0] + '-secret' : forbidden);
    }
  });

  test('billing config verifies relationship access and returns a fixed local-data projection', async () => {
    const db = { query: async sql => {
      if (sql.startsWith('SELECT r.id')) return { rows: [{ id: 3 }] };
      if (sql.includes('FROM relationships WHERE')) return { rows: [{ billing_accounts: ['default'], billing_emails: ['billing@example.com'], aum_billing_enabled: true, aum_annual_rate: '0.69' }] };
      if (sql.includes('FROM people WHERE relationship_id')) return { rows: [{ id: 22, first_name: 'Pat', last_name: 'Client', email: 'pat@example.com', financial_planning_enabled: true, blueleaf_household_id: 'provider-id' }] };
      return { rows: [{ id: 4, person_id: 22, label: 'Managed', enabled: true, annual_rate: '0.69', provider_payload: { secret: true } }] };
    } };
    const config = await business.getBillingConfig({ firmId: 7, staffUserId: 11, relationshipId: 3, db });
    expect(config).toMatchObject({ relationship_id: 3, billing_accounts: ['default'], aum_annual_rate: 0.69 });
    expect(JSON.stringify(config)).not.toContain('provider-id');
    expect(JSON.stringify(config)).not.toContain('provider_payload');
  });

  test('investment read verifies person scope and strips provider account numbers, holdings, IDs, and performance detail', async () => {
    const db = { query: async sql => {
      if (sql.includes('SELECT p.id')) return { rows: [{ id: 22 }] };
      if (sql.includes('SELECT financial_planning_enabled')) return { rows: [{ financial_planning_enabled: true, blueleaf_hidden_accounts: ['acct-1'] }] };
      return { rows: [{
        snapshot_date: '2026-08-29', synced_at: '2026-08-29T10:00:00Z', raw_balance: '1000',
        performance: { mtd: 0.01, qtd: 0.02, details: { raw: 'provider detail' }, performanceAccountIds: ['acct-1'] },
        accounts: [{ id: 'acct-1', name: 'Brokerage', accountNumber: '9999', accountType: 'Taxable', balance: 1000, holdings: [{ ticker: 'XYZ' }] }],
        blueleaf_household_id: 'household-secret',
      }] };
    } };
    const result = await business.getPersonInvestments({ firmId: 7, staffUserId: 11, personId: 22, db });
    expect(result.snapshot).toMatchObject({ total_balance: 1000, performance: { month_to_date: 0.01 }, accounts: [{ name: 'Brokerage', hidden: true }] });
    for (const value of ['9999', 'XYZ', 'acct-1', 'provider detail', 'household-secret']) expect(JSON.stringify(result)).not.toContain(value);
  });

  test('engagement letters use relationship access and project extracted data rather than returning it raw', async () => {
    const db = { query: async (sql, params) => ({ rows: [{
      id: 5, relationship_id: 3, relationship_name: 'Client', display_name: 'Engagement.pdf', created_at: '2026-01-01',
      extracted_data: {
        client_name: 'Client', services: { tax: { secret_prompt: 'nope' } },
        monthly_line_items: [{ description: 'Tax', amount: 500, raw_provider: 'nope' }],
        total_monthly: 500, ai_summary: 'Terms', source_text: 'entire document',
      },
    }] }) };
    const result = await business.listEngagementLetters({ firmId: 7, staffUserId: 11, limit: 10, db });
    expect(result.engagement_letters[0]).toMatchObject({ service_names: ['tax'], total_monthly: 500, monthly_line_items: [{ name: 'Tax', amount: 500 }] });
    expect(JSON.stringify(result)).not.toContain('secret_prompt');
    expect(JSON.stringify(result)).not.toContain('entire document');
  });
});

test.describe('Agent Work business record router', () => {
  async function withServer(capabilities, service, callback) {
    const app = express();
    app.use((req, _res, next) => {
      req.agentFirmId = 7;
      req.agentStaffUserId = 11;
      req.agentConnection = { capabilities };
      next();
    });
    const guard = capability => (req, res, next) => capabilities[capability] === true
      ? next()
      : res.status(403).json({ error: `Agent capability disabled: ${capability}`, code: 'capability_disabled' });
    app.use('/business', createAgentWorkBusinessRouter({ requireCapability: guard, audit: async () => {}, service }));
    const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    try { await callback(`http://127.0.0.1:${listener.address().port}`); }
    finally { await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
  }

  test('passes authenticated firm and staff scope into a bounded read', async () => {
    let input;
    await withServer({ tax_deliveries_read: true }, {
      listTaxDeliveries: async args => { input = args; return { deliveries: [], limit: 25 }; },
    }, async base => {
      const response = await fetch(`${base}/business/tax-deliveries?company_id=4&limit=25`);
      expect(response.status).toBe(200);
      expect(input).toMatchObject({ firmId: 7, staffUserId: 11, companyId: '4', limit: '25' });
    });
  });

  test('enforces domain-specific capabilities and exposes GET routes only', async () => {
    await withServer({ proposals_read: false }, { listProposals: async () => { throw new Error('must not run'); } }, async base => {
      const denied = await fetch(`${base}/business/proposals`);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'capability_disabled' });
      const write = await fetch(`${base}/business/proposals`, { method: 'POST' });
      expect(write.status).toBe(404);
    });
  });

  test('contains no mutation routes or external provider modules', () => {
    const root = path.join(__dirname, '..', '..');
    const router = fs.readFileSync(path.join(root, 'server/routes/agent-work-business.js'), 'utf8');
    const service = fs.readFileSync(path.join(root, 'server/services/agentBusinessRecords.js'), 'utf8');
    expect(router).not.toMatch(/router\.(post|put|patch|delete)\(/);
    expect(service).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM|[a-z_]+)/i);
    expect(service).not.toContain("require('./blueleaf')");
    expect(service).not.toContain("require('./billingMrr')");
    expect(service).not.toContain("require('./quickbooks')");
  });
});
