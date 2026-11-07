'use strict';

const crypto = require('crypto');
const { pool } = require('../db');
const { encrypt, decrypt } = require('../utils/encryption');
const { monthlyPeriods, buildMonthlyProfitAndLoss } = require('./ledgerhqMonthlyReport');

const PROVIDER = 'ledgerhq';
const DEFAULT_LEDGERHQ_APP_BASE = 'https://ledgerhq.pro';
const DEFAULT_LEDGERHQ_API_BASE = 'https://ledgerhq.pro/api/v1';
const DEFAULT_SCOPES = [
  'companies:read',
  'accounts:read',
  'reports:read',
  'bank_accounts:read',
  'bank_transactions:read',
  'reconciliations:read',
].join(' ');

function ledgerHqConfig() {
  const appBase = (process.env.LEDGERHQ_APP_BASE || DEFAULT_LEDGERHQ_APP_BASE).replace(/\/$/, '');
  return {
    appBase,
    apiBase: (process.env.LEDGERHQ_API_BASE || `${appBase}/api/v1`).replace(/\/$/, ''),
    clientId: process.env.LEDGERHQ_CLIENT_ID || '',
    scopes: process.env.LEDGERHQ_SCOPES || DEFAULT_SCOPES,
  };
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function codeChallenge(verifier) {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

async function registerOAuthClient(redirectUri) {
  const cfg = ledgerHqConfig();
  if (cfg.clientId) return cfg.clientId;

  const res = await fetch(`${cfg.appBase}/api/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'DarkLion LedgerHQ Integration',
      redirect_uris: [redirectUri],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LedgerHQ OAuth client registration failed (${res.status}): ${body || res.statusText}`);
  }
  const data = await res.json();
  if (!data.client_id) throw new Error('LedgerHQ OAuth registration did not return client_id.');
  return data.client_id;
}

async function createOAuthStart({ firmId, staffUserId, redirectUri, returnTo }) {
  const cfg = ledgerHqConfig();
  const clientId = await registerOAuthClient(redirectUri);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = codeChallenge(verifier);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query(
    `INSERT INTO ledgerhq_oauth_states
      (state, firm_id, staff_user_id, client_id, redirect_uri, code_verifier, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [state, firmId, staffUserId || null, clientId, redirectUri, verifier, returnTo || '/settings?tab=integrations', expiresAt]
  );

  const authUrl = new URL(`${cfg.appBase}/api/oauth/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', cfg.scopes);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  return authUrl.toString();
}

async function exchangeOAuthCode({ code, state }) {
  const cfg = ledgerHqConfig();
  const { rows } = await pool.query(
    `DELETE FROM ledgerhq_oauth_states
     WHERE state = $1 AND expires_at > NOW()
     RETURNING *`,
    [state]
  );
  const oauthState = rows[0];
  if (!oauthState) throw new Error('LedgerHQ connection expired or invalid. Please try connecting again.');

  const tokenRes = await fetch(`${cfg.appBase}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauthState.redirect_uri,
      client_id: oauthState.client_id,
      code_verifier: oauthState.code_verifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`LedgerHQ token exchange failed (${tokenRes.status}): ${body || tokenRes.statusText}`);
  }

  const tokens = await tokenRes.json();
  await upsertConnection(oauthState.firm_id, {
    accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token || '',
    expiresIn: tokens.expires_in || 3600,
    providerFirmId: tokens.firm_id || tokens.organization_id || '',
    metadata: {
      client_id: oauthState.client_id,
      scope: tokens.scope || ledgerHqConfig().scopes,
      token_type: tokens.token_type || 'bearer',
    },
  });

  return { firmId: oauthState.firm_id, returnTo: oauthState.return_to || '/settings?tab=integrations' };
}

async function upsertConnection(firmId, { accessToken, refreshToken, expiresIn, providerFirmId, metadata }, db = pool) {
  const expiresAt = Date.now() + Number(expiresIn || 3600) * 1000;
  await db.query(
    `INSERT INTO bookkeeping_connections
      (firm_id, provider, status, access_token, refresh_token, token_expires_at, provider_firm_id, metadata_json, last_error, connected_at, updated_at)
     VALUES ($1, $2, 'connected', $3, $4, $5, $6, $7, '', NOW(), NOW())
     ON CONFLICT (firm_id, provider) DO UPDATE SET
       status = 'connected',
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(NULLIF(EXCLUDED.refresh_token, ''), bookkeeping_connections.refresh_token),
       token_expires_at = EXCLUDED.token_expires_at,
       provider_firm_id = COALESCE(NULLIF(EXCLUDED.provider_firm_id, ''), bookkeeping_connections.provider_firm_id),
       metadata_json = bookkeeping_connections.metadata_json || EXCLUDED.metadata_json,
       last_error = '',
       connected_at = COALESCE(bookkeeping_connections.connected_at, NOW()),
       updated_at = NOW()`,
    [firmId, PROVIDER, accessToken ? encrypt(accessToken) : '', refreshToken ? encrypt(refreshToken) : '', expiresAt, providerFirmId || '', JSON.stringify(metadata || {})]
  );
}

// Lock the stored connection so parallel report requests and separate app
// instances cannot rotate the same refresh token concurrently.
async function getAccessToken(firmId, rejectedToken) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [connection] } = await db.query(
      `SELECT * FROM bookkeeping_connections
       WHERE firm_id = $1 AND provider = $2 FOR UPDATE`, [firmId, PROVIDER]
    );
    if (!connection || connection.status !== 'connected') {
      throw new Error(connection?.last_error || 'LedgerHQ is not connected for this firm.');
    }
    connection.access_token = decrypt(connection.access_token);
    connection.refresh_token = decrypt(connection.refresh_token);
    const expired = Date.now() > Number(connection.token_expires_at || 0) - 300000;
    if (!expired && (!rejectedToken || connection.access_token !== rejectedToken)) {
      await db.query('COMMIT');
      return connection.access_token;
    }
    const cfg = ledgerHqConfig();
    const clientId = connection.metadata_json?.client_id || cfg.clientId;
    if (!connection.refresh_token || !clientId) throw new Error('Reconnect LedgerHQ in Settings.');
    const tokenRes = await fetch(`${cfg.appBase}/api/oauth/token`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: connection.refresh_token, client_id: clientId,
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.json().catch(() => ({}));
      const revoked = ['invalid_grant', 'invalid_client'].includes(detail.error);
      const message = revoked ? 'LedgerHQ authorization expired or was revoked. Reconnect LedgerHQ in Settings.'
        : `LedgerHQ token refresh temporarily failed (${tokenRes.status}). Please retry.`;
      await db.query(
        `UPDATE bookkeeping_connections SET status = $3, last_error = $4, updated_at = NOW()
         WHERE firm_id = $1 AND provider = $2`,
        [firmId, PROVIDER, revoked ? 'error' : 'connected', message]
      );
      await db.query('COMMIT');
      throw new Error(message);
    }
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('LedgerHQ did not return an access token. Please retry.');
    await upsertConnection(firmId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || connection.refresh_token,
      expiresIn: tokens.expires_in || 3600,
      providerFirmId: connection.provider_firm_id || '',
      metadata: { client_id: clientId, scope: tokens.scope || connection.metadata_json?.scope || DEFAULT_SCOPES },
    }, db);
    await db.query('COMMIT');
    return tokens.access_token;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function disconnectFirm(firmId) {
  await pool.query(
    `UPDATE bookkeeping_connections
     SET status = 'disconnected', access_token = '', refresh_token = '', token_expires_at = 0, updated_at = NOW()
     WHERE firm_id = $1 AND provider = $2`,
    [firmId, PROVIDER]
  );
}

async function ledgerHqFetchForFirm(firmId, path, query = {}) {
  const cfg = ledgerHqConfig();
  let token = await getAccessToken(firmId);
  const url = new URL(`${cfg.apiBase}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const request = () => fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  let res = await request();
  if (res.status === 401) {
    token = await getAccessToken(firmId, token);
    res = await request();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LedgerHQ API ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

async function listLedgerHqCompanies(firmId) {
  const companies = new Map();
  const cursors = new Set();
  let cursor;
  do {
    const data = await ledgerHqFetchForFirm(firmId, '/companies', { limit: 500, cursor });
    const page = data.data || data.companies;
    if (!Array.isArray(page)) throw new Error('LedgerHQ returned an invalid company list.');
    for (const company of page) companies.set(company.id || company.companyId, company);
    cursor = data.pagination?.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('LedgerHQ company pagination did not advance. Please retry.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...companies.values()].sort((a, b) =>
    String(a.name || a.companyName || a.id).trim().localeCompare(
      String(b.name || b.companyName || b.id).trim(), 'en', { sensitivity: 'base', numeric: true }
    ));
}

async function getStatus(firmId) {
  const { rows: [connection] } = await pool.query(
    `SELECT status, connected_at, provider_firm_id, last_error FROM bookkeeping_connections
     WHERE firm_id = $1 AND provider = $2 LIMIT 1`, [firmId, PROVIDER]
  );
  return {
    connected: connection?.status === 'connected',
    status: connection?.status || 'disconnected',
    connected_at: connection?.connected_at || null,
    provider_firm_id: connection?.provider_firm_id || '',
    last_error: connection?.last_error || '',
  };
}

async function getCompanyLink(companyId, firmId) {
  const { rows } = await pool.query(
    `SELECT l.* FROM company_bookkeeping_links l
     JOIN companies c ON c.id = l.darklion_company_id AND c.firm_id = l.firm_id
     WHERE l.darklion_company_id = $1 AND l.firm_id = $2 AND l.provider = $3 AND l.active = TRUE
     LIMIT 1`,
    [companyId, firmId, PROVIDER]
  );
  return rows[0] || null;
}

async function saveCompanyLink({ firmId, companyId, providerCompanyId, providerCompanyName }) {
  if (!providerCompanyId) throw new Error('LedgerHQ company is required.');
  const result = await pool.query(
    `INSERT INTO company_bookkeeping_links
      (firm_id, darklion_company_id, provider, provider_company_id, provider_company_name, active, updated_at)
     SELECT $1, c.id, $3, $4, $5, TRUE, NOW() FROM companies c WHERE c.id = $2 AND c.firm_id = $1
     ON CONFLICT (darklion_company_id, provider) DO UPDATE SET
       provider_company_id = EXCLUDED.provider_company_id,
       provider_company_name = EXCLUDED.provider_company_name,
       active = TRUE,
       updated_at = NOW()
     WHERE company_bookkeeping_links.firm_id = EXCLUDED.firm_id`,
    [firmId, companyId, PROVIDER, providerCompanyId, providerCompanyName || '']
  );
  if (!result.rowCount) throw new Error('Company ownership does not match');
  return getCompanyLink(companyId, firmId);
}

async function clearCompanyLink({ firmId, companyId }) {
  await pool.query(
    `UPDATE company_bookkeeping_links
     SET active = FALSE, updated_at = NOW()
     WHERE firm_id = $1 AND darklion_company_id = $2 AND provider = $3
       AND EXISTS (SELECT 1 FROM companies c WHERE c.id = $2 AND c.firm_id = $1)`,
    [firmId, companyId, PROVIDER]
  );
}

function defaultClosePackageYear(now = new Date()) {
  return now.getFullYear() - 1;
}

function defaultClosePackagePeriod(now = new Date()) {
  return String(defaultClosePackageYear(now));
}

function lastDayOfMonth(year, month) {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateRangeForPeriod(period) {
  const normalized = String(period || defaultClosePackagePeriod()).trim();
  if (/^\d{4}$/.test(normalized)) {
    const year = Number(normalized);
    return { startDate: `${year}-01-01`, endDate: `${year}-12-31`, asOf: `${year}-12-31` };
  }
  if (/^\d{4}-\d{2}$/.test(normalized)) {
    const [year, month] = normalized.split('-').map(Number);
    const endDate = lastDayOfMonth(year, month);
    return { startDate: `${year}-${String(month).padStart(2, '0')}-01`, endDate, asOf: endDate };
  }
  throw new Error(`Unsupported close package period: ${normalized}`);
}

function moneyToNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const text = String(value).replace(/[$,]/g, '').trim();
  if (!text) return 0;
  const isParen = /^\(.*\)$/.test(text);
  const n = Number(text.replace(/[()]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return isParen ? -n : n;
}

function formatAmount(value) {
  const n = Number(value || 0);
  return n.toFixed(2);
}

function humanLabel(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

const REPORT_WRAPPER_KEYS = ['data', 'report', 'result', 'statement', 'payload', 'financials'];
const ROW_ARRAY_KEYS = ['rows', 'lines', 'accounts', 'items', 'children', 'subrows', 'details'];
const SECTION_KEYS = [
  ['revenue', 'Revenue'],
  ['income', 'Income'],
  ['sales', 'Sales'],
  ['costOfGoodsSold', 'Cost Of Goods Sold'],
  ['cogs', 'Cost Of Goods Sold'],
  ['expenses', 'Expenses'],
  ['otherIncome', 'Other Income'],
  ['otherExpenses', 'Other Expenses'],
  ['assets', 'Assets'],
  ['liabilities', 'Liabilities'],
  ['equity', 'Equity'],
];
const META_KEYS = new Set([
  'id',
  'companyId',
  'currency',
  'period',
  'startDate',
  'endDate',
  'asOf',
  'generatedAt',
  'from',
  'to',
]);

function unwrapReport(input) {
  let data = input;
  for (let i = 0; i < 4 && isObject(data); i += 1) {
    const key = REPORT_WRAPPER_KEYS.find(k => data[k] && (Array.isArray(data[k]) || isObject(data[k])));
    if (!key) break;
    data = data[key];
  }
  return data;
}

function rowHasValue(row) {
  if (!isObject(row)) return false;
  const centsKeys = [
    'amountCents',
    'balanceCents',
    'netAmountCents',
    'totalCents',
    'valueCents',
    'debitCents',
    'creditCents',
    'actualCents',
    'periodCents',
    'currentPeriodCents',
    'ytdCents',
    'netIncomeCents',
    'netProfitCents',
  ];
  const amountKeys = [
    'amount',
    'balance',
    'netAmount',
    'total',
    'value',
    'current',
    'actual',
    'periodAmount',
    'currentPeriod',
    'ytd',
    'netIncome',
    'netProfit',
  ];
  return centsKeys.some(key => row[key] !== undefined && row[key] !== null)
    || amountKeys.some(key => row[key] !== undefined && row[key] !== null);
}

function normalizeReportObjectRows(data, depth) {
  const rows = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (META_KEYS.has(key) || value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'string') {
      if (moneyToNumber(value) !== 0) rows.push({ label: key, amount: value });
      continue;
    }
    if (!isObject(value) && !Array.isArray(value)) continue;

    const childRows = findRows(value, depth + 1);
    if (childRows.length) {
      rows.push({
        ...(isObject(value) ? value : {}),
        label: isObject(value) ? labelFromRow({ ...value, label: value.label || value.name || key }) : key,
        name: isObject(value) ? value.name || key : key,
        _rows: childRows,
      });
    } else if (isObject(value) && rowHasValue(value)) {
      rows.push({ ...value, label: value.label || value.name || key, name: value.name || key });
    }
  }
  return rows;
}

function findRows(input, depth = 0) {
  if (depth > 10) return [];
  if (!input) return [];
  if (Array.isArray(input)) return input;
  const data = unwrapReport(input);
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return [];

  for (const key of ROW_ARRAY_KEYS) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (data.sections && Array.isArray(data.sections)) {
    return data.sections.flatMap(section => {
      const rows = findRows(section, depth + 1);
      return rows.length
        ? [{ _section: section.name || section.label || section.title, _rows: rows, _summaryValue: valueFromRow(section) }]
        : [];
    });
  }

  const sectionRows = [];
  for (const [key, label] of SECTION_KEYS) {
    if (data[key] === undefined || data[key] === null) continue;
    const rows = findRows(data[key], depth + 1);
    if (rows.length) {
      sectionRows.push({ _section: label, _rows: rows, _summaryValue: valueFromRow(data[key]) });
    } else if (isObject(data[key]) && rowHasValue(data[key])) {
      sectionRows.push({ ...data[key], label });
    }
  }
  if (sectionRows.length) return sectionRows;

  for (const key of ROW_ARRAY_KEYS) {
    if (isObject(data[key])) return findRows(data[key], depth + 1);
  }

  return normalizeReportObjectRows(data, depth);
}

function findChildRows(row) {
  if (!isObject(row)) return [];
  if (row._rows) return row._rows;
  if (row.sections && Array.isArray(row.sections)) return findRows({ sections: row.sections });
  for (const key of ROW_ARRAY_KEYS) {
    if (Array.isArray(row[key])) return row[key];
    if (isObject(row[key])) return findRows(row[key]);
  }
  return [];
}

function valueFromRow(row) {
  const centsKeys = [
    'amountCents',
    'balanceCents',
    'netAmountCents',
    'totalCents',
    'valueCents',
    'debitCents',
    'creditCents',
    'actualCents',
    'periodCents',
    'currentPeriodCents',
    'ytdCents',
    'netIncomeCents',
    'netProfitCents',
  ];
  for (const key of centsKeys) {
    if (row[key] !== undefined && row[key] !== null) return moneyToNumber(row[key]) / 100;
  }
  const amountKeys = [
    'amount',
    'balance',
    'netAmount',
    'total',
    'value',
    'current',
    'actual',
    'periodAmount',
    'currentPeriod',
    'ytd',
    'netIncome',
    'netProfit',
  ];
  for (const key of amountKeys) {
    if (row[key] !== undefined && row[key] !== null) return moneyToNumber(row[key]);
  }
  if (row.debit !== undefined || row.credit !== undefined) return moneyToNumber(row.debit) - moneyToNumber(row.credit);
  return 0;
}

function labelFromRow(row) {
  return row.label || row.name || row.accountName || row.account || row.title || row.description || row.category || row.type || 'Total';
}

function normalizeRows(rows) {
  const normalized = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row._section) {
      normalized.push({
        type: 'Section',
        Header: { ColData: [{ value: humanLabel(row._section) }, { value: '' }] },
        Rows: { Row: normalizeRows(row._rows || []) },
        Summary: { ColData: [{ value: `Total ${humanLabel(row._section)}` }, { value: formatAmount(row._summaryValue || 0) }] },
      });
      continue;
    }
    const children = findChildRows(row);
    if (children.length && children !== row) {
      normalized.push({
        type: 'Section',
        Header: { ColData: [{ value: labelFromRow(row) }, { value: '' }] },
        Rows: { Row: normalizeRows(children) },
        Summary: { ColData: [{ value: `Total ${labelFromRow(row)}` }, { value: formatAmount(valueFromRow(row)) }] },
      });
      continue;
    }
    normalized.push({
      type: 'Data',
      ColData: [{ value: labelFromRow(row) }, { value: formatAmount(valueFromRow(row)) }],
    });
  }
  return normalized;
}

function normalizeLedgerHqReport(raw, reportName, startDate, endDate) {
  const data = unwrapReport(raw);
  if (data?.Rows?.Row) return data;
  if ((data?.startDate && data.startDate !== startDate) ||
      (data?.endDate && data.endDate !== endDate) || (data?.asOf && data.asOf !== endDate)) {
    throw new Error(`LedgerHQ ${reportName} dates do not match the requested period.`);
  }
  const accountCell = name => ({ value: name });
  const centsCell = cents => {
    if (!Number.isSafeInteger(cents)) throw new Error(`Invalid ${reportName} amount from LedgerHQ.`);
    return { value: (cents / 100).toFixed(2) };
  };
  let rows;
  let columns = ['Account', 'Total'];
  if (reportName === 'Trial Balance') {
    if (!Array.isArray(data?.accounts)) throw new Error('Invalid LedgerHQ trial balance.');
    columns = ['Account', 'Debit', 'Credit'];
    let debit = 0, credit = 0;
    rows = data.accounts.map(account => {
      const cells = [accountCell(account.name), centsCell(account.debitBalanceCents), centsCell(account.creditBalanceCents)];
      debit += account.debitBalanceCents;
      credit += account.creditBalanceCents;
      return { type: 'Data', ColData: cells };
    });
    rows.push({ type: 'Section', Summary: { ColData: [accountCell('Total'), centsCell(debit), centsCell(credit)] } });
  } else {
    const sections = reportName === 'Profit and Loss' ? ['revenue', 'expenses'] : ['assets', 'liabilities', 'equity'];
    for (const key of sections) {
      if (!Array.isArray(data?.[key]?.accounts)) throw new Error(`Invalid LedgerHQ ${reportName}.`);
      centsCell(data[key].totalCents);
      for (const account of data[key].accounts) centsCell(account.balanceCents ?? account.amountCents);
    }
    rows = normalizeRows(findRows(data));
    if (reportName === 'Profit and Loss') {
      rows.push({ type: 'Section', Summary: { ColData: [accountCell('Net Income'), centsCell(data.netIncomeCents)] } });
    } else {
      rows.push({ type: 'Section', Summary: { ColData: [accountCell('Total Liabilities and Equity'), centsCell(data.liabilities.totalCents + data.equity.totalCents)] } });
    }
  }
  return {
    Header: { ReportName: reportName, StartPeriod: startDate || '', EndPeriod: endDate || '', ReportBasis: data.basis || '' },
    Columns: { Column: columns.map((title, index) => ({ ColTitle: title, ColType: index ? 'Money' : 'Account' })) },
    Rows: { Row: rows },
    _ledgerhqRaw: raw,
  };
}

async function generateLedgerHqClosePackage(companyId, firmId, period, customStart, customEnd) {
  const link = await getCompanyLink(companyId, firmId);
  if (!link) throw new Error('Choose a LedgerHQ company for this DarkLion company first.');

  const normalizedPeriod = String(period || defaultClosePackagePeriod()).trim();
  let startDate, endDate, asOf;
  if (customStart && customEnd) {
    startDate = customStart;
    endDate = customEnd;
    asOf = customEnd;
  } else {
    ({ startDate, endDate, asOf } = dateRangeForPeriod(normalizedPeriod));
  }

  const periods = monthlyPeriods(startDate, endDate);
  const companyPath = `/companies/${encodeURIComponent(link.provider_company_id)}/reports`;
  const [pnlResult, bsResult, tbResult] = await Promise.all([
    ledgerHqFetchForFirm(firmId, `${companyPath}/profit-and-loss`, { startDate, endDate }).then(data => ({ ok: true, data })).catch(e => ({ ok: false, error: e.message })),
    ledgerHqFetchForFirm(firmId, `${companyPath}/balance-sheet`, { asOf }).then(data => ({ ok: true, data })).catch(e => ({ ok: false, error: e.message })),
    ledgerHqFetchForFirm(firmId, `${companyPath}/trial-balance`, { asOf }).then(data => ({ ok: true, data })).catch(e => ({ ok: false, error: e.message })),
  ]);

  if (!pnlResult.ok || !bsResult.ok || !tbResult.ok) {
    throw new Error(`LedgerHQ reports failed: ${pnlResult.error || bsResult.error || tbResult.error}`);
  }

  let pnl = normalizeLedgerHqReport(pnlResult.data, 'Profit and Loss', startDate, endDate);
  if (periods.length > 1) {
    const months = [];
    // Bound upstream concurrency; never replace missing months with zeroes.
    for (let offset = 0; offset < periods.length; offset += 3) {
      months.push(...await Promise.all(periods.slice(offset, offset + 3).map(async month => {
        const raw = await ledgerHqFetchForFirm(firmId, `${companyPath}/profit-and-loss`, {
          startDate: month.startDate, endDate: month.endDate, basis: pnl.Header.ReportBasis,
        });
        normalizeLedgerHqReport(raw, 'Profit and Loss', month.startDate, month.endDate);
        return { ...month, data: unwrapReport(raw) };
      })));
    }
    pnl = buildMonthlyProfitAndLoss(pnl, unwrapReport(pnlResult.data), months);
  }

  const reportData = {
    provider: PROVIDER,
    ledgerHqCompanyId: link.provider_company_id,
    ledgerHqCompanyName: link.provider_company_name || '',
    period: normalizedPeriod,
    generatedAt: new Date().toISOString(),
    pnl,
    balanceSheet: bsResult.ok ? normalizeLedgerHqReport(bsResult.data, 'Balance Sheet', asOf, asOf) : null,
    trialBalance: tbResult.ok ? normalizeLedgerHqReport(tbResult.data, 'Trial Balance', asOf, asOf) : null,
    checklist: [
      { item: 'P&L', status: pnlResult.ok ? 'ok' : 'missing', error: pnlResult.error || null },
      { item: 'Balance Sheet', status: bsResult.ok ? 'ok' : 'missing', error: bsResult.error || null },
      { item: 'Trial Balance', status: tbResult.ok ? 'ok' : 'missing', error: tbResult.error || null },
    ],
  };

  const { rows: existing } = await pool.query(
    `SELECT id FROM ledgerhq_close_packages
     WHERE darklion_company_id = $1 AND ledgerhq_company_id = $2 AND period = $3 AND firm_id = $4
     ORDER BY generated_at DESC
     LIMIT 1`,
    [companyId, link.provider_company_id, normalizedPeriod, firmId]
  );

  if (existing[0]) {
    const { rows: [pkg] } = await pool.query(
      `UPDATE ledgerhq_close_packages
       SET report_data = $4, generated_at = NOW(), status = 'draft'
       WHERE id = $1 AND darklion_company_id = $2 AND ledgerhq_company_id = $3 AND firm_id = $5
       RETURNING *`,
      [existing[0].id, companyId, link.provider_company_id, JSON.stringify(reportData), firmId || null]
    );
    return pkg;
  }

  const { rows: [pkg] } = await pool.query(
    `INSERT INTO ledgerhq_close_packages
      (firm_id, darklion_company_id, ledgerhq_company_id, period, report_data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [firmId || null, companyId, link.provider_company_id, normalizedPeriod, JSON.stringify(reportData)]
  );
  return pkg;
}

async function listLedgerHqClosePackages(companyId, firmId) {
  const link = await getCompanyLink(companyId, firmId);
  if (!link) return [];
  const { rows } = await pool.query(
    `SELECT id, period, status, report_data, generated_at, ledgerhq_company_id
     FROM ledgerhq_close_packages
     WHERE darklion_company_id = $1 AND ledgerhq_company_id = $2 AND firm_id = $3
     ORDER BY generated_at DESC`,
    [companyId, link.provider_company_id, firmId]
  );
  return rows;
}

module.exports = {
  PROVIDER,
  createOAuthStart,
  exchangeOAuthCode,
  disconnectFirm,
  getStatus,
  listLedgerHqCompanies,
  getCompanyLink,
  saveCompanyLink,
  clearCompanyLink,
  generateLedgerHqClosePackage,
  listLedgerHqClosePackages,
  normalizeLedgerHqReport,
};
