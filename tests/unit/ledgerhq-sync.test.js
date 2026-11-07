'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../server/services/ledgerhq.js'), 'utf8');

// Exercise the service with isolated DB/HTTP boundaries, without live credentials.
function service({ expired = false, fetcher, status = 'connected' } = {}) {
  const connection = { firm_id: 1, status, access_token: 'old-access', refresh_token: 'old-refresh',
    token_expires_at: Date.now() + (expired ? -1000 : 3600000), metadata_json: { client_id: 'client' } };
  const writes = [], requests = [];
  let tail = Promise.resolve();
  const query = async (sql, args) => {
    if (sql.includes('SELECT') && sql.includes('bookkeeping_connections')) return { rows: [{ ...connection }] };
    if (sql.includes('INSERT INTO bookkeeping_connections')) {
      Object.assign(connection, { access_token: args[2], refresh_token: args[3], token_expires_at: args[4], status: 'connected', last_error: '' });
    } else if (sql.includes('UPDATE bookkeeping_connections')) {
      Object.assign(connection, { status: args[2], last_error: args[3] });
    } else if (sql.includes('company_bookkeeping_links')) {
      return { rows: [{ provider_company_id: 'lhq-a', provider_company_name: 'Company A' }] };
    } else if (sql.includes('ledgerhq_close_packages')) {
      if (sql.includes('SELECT')) return { rows: [] };
      writes.push(args); return { rows: [{ report_data: JSON.parse(args[4]) }] };
    }
    return { rows: [] };
  };
  const pool = { query, async connect() {
    const prev = tail; let release;
    tail = new Promise(resolve => { release = resolve; });
    await prev;
    return { query, release };
  } };
  const context = { module: { exports: {} }, require: name => name === '../db' ? { pool } : name === '../utils/encryption' ? {encrypt:value=>'encrypted:'+value,decrypt:value=>value?.replace(/^encrypted:/,'')} : name === './ledgerhqMonthlyReport' ? require('../../server/services/ledgerhqMonthlyReport') : require(name),
    process: { env: {} }, Buffer, URL, URLSearchParams, AbortSignal, Date,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return fetcher(String(url), options, connection);
    } };
  vm.runInNewContext(source, context);
  return { api: context.module.exports, connection, requests, writes };
}
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const pnl = { startDate: '2025-01-01', endDate: '2025-12-31', basis: 'cash',
  revenue: { accounts: [{ name: 'ABC Medical, Inc.', balanceCents: 12834746 }], totalCents: 12834746 },
  expenses: { accounts: [{ name: 'Refund', balanceCents: -10025 }], totalCents: -10025 }, netIncomeCents: 12844771 };
const bs = { basis: 'cash', assets: { accounts: [], totalCents: 10000 }, liabilities: { accounts: [], totalCents: 2500 }, equity: { accounts: [], totalCents: 7500 } };
const tb = { basis: 'cash', accounts: [{ name: 'Bank', debitBalanceCents: 10000, creditBalanceCents: 0, balanceCents: 10000 },
  { name: 'Revenue', debitBalanceCents: 0, creditBalanceCents: 10000, balanceCents: 10000 }] };

test('P&L preserves cents, negative values, exact account names and net income', () => {
  const report = service().api.normalizeLedgerHqReport({ data: pnl }, 'Profit and Loss', pnl.startDate, pnl.endDate);
  assert.equal(report.Rows.Row[0].Rows.Row[0].ColData[0].value, 'ABC Medical, Inc.');
  assert.equal(report.Rows.Row[0].Rows.Row[0].ColData[1].value, '128347.46');
  assert.equal(report.Rows.Row[1].Rows.Row[0].ColData[1].value, '-100.25');
  assert.equal(report.Rows.Row[2].Summary.ColData[1].value, '128447.71');
  assert.equal(report.Header.ReportBasis, 'cash');
});
test('balance sheet includes liabilities and equity total; trial balance preserves debit/credit sides', () => {
  const api = service().api;
  assert.equal(api.normalizeLedgerHqReport({ data: bs }, 'Balance Sheet').Rows.Row[3].Summary.ColData[1].value, '100.00');
  const report = api.normalizeLedgerHqReport({ data: tb }, 'Trial Balance');
  assert.equal(report.Columns.Column[2].ColTitle, 'Credit');
  assert.equal(report.Rows.Row[1].ColData[1].value, '0.00');
  assert.equal(report.Rows.Row[1].ColData[2].value, '100.00');
  assert.equal(report.Rows.Row[2].Summary.ColData[1].value, '100.00');
});
test('malformed financial responses fail instead of becoming zero-valued reports', () => {
  const api = service().api;
  assert.throws(() => api.normalizeLedgerHqReport({ data: {} }, 'Profit and Loss'), /Invalid/);
  assert.throws(() => api.normalizeLedgerHqReport({ data: pnl }, 'Profit and Loss', '2024-01-01', '2024-12-31'), /dates do not match/);
  assert.throws(() => api.normalizeLedgerHqReport({ data: { ...pnl, netIncomeCents: 'bad' } }, 'Profit and Loss', pnl.startDate, pnl.endDate), /Invalid/);
});
test('company list follows all pages and sorts names case-insensitively', async () => {
  const s = service({ fetcher: async url => response(new URL(url).searchParams.has('cursor')
    ? { data: [{ id: 'a', name: 'alpha' }], pagination: {} }
    : { data: [{ id: 'z', name: 'Zulu' }, { id: 'b', name: 'Beta' }], pagination: { nextCursor: 'b' } }) });
  const rows = await s.api.listLedgerHqCompanies(1);
  assert.equal(rows.map(x => x.name).join(','), 'alpha,Beta,Zulu');
  assert.equal(s.requests.length, 2);
});
test('parallel requests rotate an expired token only once', async () => {
  let refreshes = 0;
  const s = service({ expired: true, fetcher: async (url, options) => {
    if (url.endsWith('/token')) { refreshes++; return response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }); }
    assert.equal(options.headers.Authorization, 'Bearer new-access');
    return response({ data: [] });
  } });
  await Promise.all([s.api.listLedgerHqCompanies(1), s.api.listLedgerHqCompanies(1), s.api.listLedgerHqCompanies(1)]);
  assert.equal(refreshes, 1);
  assert.equal(s.connection.refresh_token, 'encrypted:new-refresh');
});
test('401 renews once and retries the rejected request', async () => {
  let refreshes = 0;
  const s = service({ fetcher: async (url, options) => {
    if (url.endsWith('/token')) { refreshes++; return response({ access_token: 'new-access' }); }
    return options.headers.Authorization === 'Bearer old-access' ? response({}, 401) : response({ data: [] });
  } });
  await s.api.listLedgerHqCompanies(1);
  assert.equal(refreshes, 1);
});
test('temporary refresh failure retries later; revoked authorization exposes reconnect reason', async () => {
  for (const revoked of [false, true]) {
    let attempts = 0;
    const s = service({ expired: true, fetcher: async url => {
      if (!url.endsWith('/token')) return response({ data: [] });
      attempts++;
      return attempts === 1 ? response({ error: revoked ? 'invalid_grant' : 'temporarily_unavailable' }, revoked ? 400 : 503)
        : response({ access_token: 'new-access' });
    } });
    await assert.rejects(s.api.listLedgerHqCompanies(1));
    assert.equal(s.connection.status, revoked ? 'error' : 'connected');
    if (revoked) assert.match((await s.api.getStatus(1)).last_error, /Reconnect/);
    else await s.api.listLedgerHqCompanies(1);
  }
});
test('monthly fetch uses month dates, persists fresh results, and never saves partial failures', async () => {
  for (const fail of [false, true]) {
    const s = service({ fetcher: async url => {
      const u = new URL(url);
      if (u.pathname.endsWith('profit-and-loss')) {
        assert.equal(u.searchParams.get('startDate'), '2025-09-01');
        assert.equal(u.searchParams.get('endDate'), '2025-09-30');
        return response({ data: { ...pnl, startDate: '2025-09-01', endDate: '2025-09-30' } });
      }
      if (u.pathname.endsWith('balance-sheet')) return response({ data: bs });
      return fail ? response({}, 503) : response({ data: tb });
    } });
    if (fail) { await assert.rejects(s.api.generateLedgerHqClosePackage(12, 1, '2025-09')); assert.equal(s.writes.length, 0); }
    else { const pkg = await s.api.generateLedgerHqClosePackage(12, 1, '2025-09'); assert.equal(pkg.report_data.ledgerHqCompanyId, 'lhq-a'); assert.equal(s.writes.length, 1); }
  }
});

test('annual and YTD packages fetch bounded monthly P&Ls while keeping balance reports as end-date snapshots', async () => {
  for (const end of ['2026-12-31', '2026-09-26']) {
    const count = Number(end.slice(5, 7));
    const s = service({ fetcher: async url => {
      const u = new URL(url);
      if (u.pathname.endsWith('profit-and-loss')) {
        const startDate = u.searchParams.get('startDate'), endDate = u.searchParams.get('endDate');
        const factor = startDate === '2026-01-01' && endDate === end ? count : 1;
        if (factor === 1) assert.equal(u.searchParams.get('basis'), 'cash');
        return response({ data: { ...pnl, startDate, endDate,
          revenue: { accounts: [{ accountId: 'a', name: 'Revenue', balanceCents: 10000 * factor }], totalCents: 10000 * factor },
          expenses: { accounts: [], totalCents: 0 }, netIncomeCents: 10000 * factor } });
      }
      assert.equal(u.searchParams.get('asOf'), end);
      return response({ data: u.pathname.endsWith('balance-sheet') ? bs : tb });
    } });
    const pkg = await s.api.generateLedgerHqClosePackage(12, 1, '2026', '2026-01-01', end);
    assert.equal(pkg.report_data.pnl.Columns.Column.length, count + 2);
    assert.equal(pkg.report_data.pnl.Rows.Row.at(-1).Summary.ColData.at(-1).value, (100 * count).toFixed(2));
    assert.equal(pkg.report_data.balanceSheet.Columns.Column.length, 2);
    assert.equal(pkg.report_data.trialBalance.Columns.Column.length, 3);
    assert.equal(s.requests.length, count + 3);
  }
});

test('failed monthly reads cannot save a misleading annual package', async () => {
  const s = service({ fetcher: async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('profit-and-loss')) {
      if (u.searchParams.get('endDate') !== '2025-12-31') return response({}, 503);
      return response({ data: pnl });
    }
    return response({ data: u.pathname.endsWith('balance-sheet') ? bs : tb });
  } });
  await assert.rejects(s.api.generateLedgerHqClosePackage(12,1,'2025'), /503/);
  assert.equal(s.writes.length, 0);
});
