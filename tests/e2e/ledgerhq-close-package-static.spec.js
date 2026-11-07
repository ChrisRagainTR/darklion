// tests/e2e/ledgerhq-close-package-static.spec.js
// Static contract checks for the LedgerHQ close package V1 integration.

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

test.describe('LedgerHQ close package V1 contracts', () => {
  test('normalizes nested LedgerHQ income statement and balance sheet reports into display rows', () => {
    const { normalizeLedgerHqReport } = require('../../server/services/ledgerhq');

    const pnl = normalizeLedgerHqReport({
      data: {
        netIncomeCents: 82500,
        revenue: {
          totalCents: 125000,
          accounts: [{ name: 'Advisory Fees', amountCents: 125000 }],
        },
        expenses: {
          totalCents: 42500,
          accounts: [{ name: 'Software', amountCents: 42500 }],
        },
      },
    }, 'Profit and Loss', '2026-01-01', '2026-02-28');

    const balanceSheet = normalizeLedgerHqReport({
      data: {
        assets: {
          totalCents: 250000,
          accounts: [{ name: 'Operating Checking', balanceCents: 250000 }],
        },
        liabilities: {
          totalCents: 80000,
          accounts: [{ name: 'Credit Card', balanceCents: 80000 }],
        },
        equity: {
          totalCents: 170000,
          accounts: [{ name: 'Owner Equity', balanceCents: 170000 }],
        },
      },
    }, 'Balance Sheet', '2026-02-28', '2026-02-28');

    expect(JSON.stringify(pnl.Rows.Row)).toContain('Advisory Fees');
    expect(JSON.stringify(pnl.Rows.Row)).toContain('Software');
    expect(JSON.stringify(balanceSheet.Rows.Row)).toContain('Operating Checking');
    expect(JSON.stringify(balanceSheet.Rows.Row)).toContain('Credit Card');
    expect(JSON.stringify(balanceSheet.Rows.Row)).toContain('Owner Equity');
  });

  test('LedgerHQ service uses firm OAuth, company mapping, and report normalization', () => {
    const source = readRepoFile('server/services/ledgerhq.js');

    expect(source).toContain('LEDGERHQ_API_BASE');
    expect(source).toContain('createOAuthStart');
    expect(source).toContain('exchangeOAuthCode');
    expect(source).toContain('listLedgerHqCompanies');
    expect(source).toContain('saveCompanyLink');
    expect(source).toContain('getCompanyLink');
    expect(source).toContain('function normalizeLedgerHqReport');
    expect(source).toContain('Rows: { Row: rows }');
    expect(source).toContain("provider: PROVIDER");
  });

  test('database keeps firm connections, company mappings, and LedgerHQ packages separate from QBO packages', () => {
    const db = compact(readRepoFile('server/db.js'));

    expect(db).toContain('CREATE TABLE IF NOT EXISTS close_packages');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS ledgerhq_close_packages');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS bookkeeping_connections');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS company_bookkeeping_links');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS ledgerhq_oauth_states');
    expect(db).toContain('darklion_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE');
    expect(db).toContain('ledgerhq_company_id TEXT NOT NULL');
    expect(db).toContain('UNIQUE(darklion_company_id, ledgerhq_company_id, period)');
    expect(db).toContain('UNIQUE(firm_id, provider)');
    expect(db).toContain('UNIQUE(darklion_company_id, provider)');
  });

  test('API exposes numeric company LedgerHQ close package routes without replacing QBO realm routes', () => {
    const api = readRepoFile('server/routes/api.js');

    expect(api).toContain("router.post('/companies/:realmId/close-package'");
    expect(api).toContain("router.get('/companies/:realmId/close-packages'");
    expect(api).toContain("router.post('/companies/id/:id([0-9]+)/ledgerhq/close-package'");
    expect(api).toContain("router.get('/companies/id/:id([0-9]+)/ledgerhq/close-packages'");
    expect(api).toContain('generateClosePackageForProvider');
    expect(api).toContain("provider: 'ledgerhq'");
    expect(api).toContain('listLedgerHqClosePackages(companyId, firmId)');
  });

  test('LedgerHQ routes expose firm connection, company list, and company mapping endpoints', () => {
    const source = readRepoFile('server/routes/ledgerhq.js');
    const index = readRepoFile('server/index.js');

    expect(source).toContain("router.post('/connect/start'");
    expect(source).toContain("router.post('/disconnect'");
    expect(source).toContain("router.get('/companies'");
    expect(source).toContain("router.put('/company-links/:companyId([0-9]+)'");
    expect(source).toContain("publicRouter.get('/oauth/callback'");
    expect(index).toContain("app.use('/ledgerhq', ledgerHqRoutes.publicRouter)");
    expect(index).toContain("app.use('/api/ledgerhq', requireFirm, apiLimiter, ledgerHqRoutes.router)");
  });

  test('provider boundary dispatches close package generation by provider', () => {
    const source = readRepoFile('server/services/closePackageProvider.js');

    expect(source).toContain('generateClosePackageForProvider');
    expect(source).toContain("provider === 'ledgerhq'");
    expect(source).toContain("provider === 'qbo'");
    expect(source).toContain('generateLedgerHqClosePackage');
    expect(source).toContain('generateClosePackage(');
  });

  test('staff company page can select LedgerHQ for close package generation', () => {
    const view = readRepoFile('server/views/crm-company.ejs');

    expect(view).toContain('bk-cp-provider-ledgerhq');
    expect(view).toContain('bk-ledgerhq-company-select');
    expect(view).toContain("bk_setClosePackageProvider('ledgerhq')");
    expect(view).toContain("apiFetch('/api/ledgerhq/companies')");
    expect(view).toContain("apiFetch('/api/ledgerhq/company-links/'+companyId");
    expect(view).toContain("'/api/companies/id/'+companyId+'/ledgerhq/close-package'");
    expect(view).toContain("'/api/companies/id/'+companyId+'/ledgerhq/close-packages'");
    expect(view).toContain('companyData.ledgerhq_connected');
    expect(view).toContain('QuickBooks reports use the existing connected QBO company.');
    expect(view).toContain("document.getElementById('tab-bk-reports')");
    expect(view).toContain('bk_hasQboRealmRecord');
    expect(view).toContain("bk_qboConnectCardHtml(true)");
    expect(view).toContain('bk_cpShowZeroAccounts = false');
    expect(view).toContain('Show zero accounts');
    expect(view).toContain('bk_toggleZeroAccounts');
    expect(view).toContain('No non-zero accounts.');
  });

  test('settings integrations tab owns the one-time firm LedgerHQ connection', () => {
    const view = readRepoFile('server/views/settings.ejs');

    expect(view).toContain('Connect LedgerHQ');
    expect(view).toContain("apiFetch('/api/ledgerhq/status')");
    expect(view).toContain("apiFetch('/api/ledgerhq/connect/start'");
    expect(view).toContain("apiFetch('/api/ledgerhq/disconnect'");
    expect(view).toContain("apiFetch('/api/ledgerhq/companies')");
    expect(view).toContain('Connect LedgerHQ once for the firm');
  });
});
