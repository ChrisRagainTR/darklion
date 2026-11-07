'use strict';

const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

const DEFAULT_TYPES = ['Purchase', 'Bill', 'Deposit', 'SalesReceipt', 'Invoice', 'Payment', 'JournalEntry', 'CreditMemo', 'VendorCredit', 'RefundReceipt'];
const QBO_PAGE_SIZE = 1000;
const MAX_MONTHS = 84;

function monthsAgoDate(months = 24) {
  const n = Number(months);
  const safeMonths = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_MONTHS) : 24;
  const d = new Date();
  d.setMonth(d.getMonth() - safeMonths);
  return d.toISOString().split('T')[0];
}

function safeTypes(types) {
  if (!Array.isArray(types) || types.length === 0) return DEFAULT_TYPES;
  const allowed = new Set(DEFAULT_TYPES.map(t => t.toLowerCase()));
  const cleaned = [];
  const seen = new Set();
  for (const raw of types) {
    const type = String(raw || '').trim();
    const match = DEFAULT_TYPES.find(t => t.toLowerCase() === type.toLowerCase());
    if (!match || !allowed.has(match.toLowerCase()) || seen.has(match)) continue;
    seen.add(match);
    cleaned.push(match);
  }
  return cleaned.length ? cleaned : DEFAULT_TYPES;
}

function refName(ref) {
  return ref?.name || ref?.Name || ref?.value || ref?.Value || '';
}

function firstLine(txn, predicate) {
  return (txn.Line || []).find(predicate) || (txn.Line || [])[0] || {};
}

function lineDescriptions(txn) {
  return (txn.Line || [])
    .map(line => line.Description || line.DetailType || '')
    .filter(Boolean)
    .join(' | ')
    .slice(0, 2000);
}

function lineAccounts(txn) {
  const names = [];
  for (const line of txn.Line || []) {
    const refs = [
      line.AccountBasedExpenseLineDetail?.AccountRef,
      line.DepositLineDetail?.AccountRef,
      line.SalesItemLineDetail?.ItemRef,
      line.JournalEntryLineDetail?.AccountRef,
      line.DiscountLineDetail?.DiscountAccountRef,
    ];
    for (const ref of refs) {
      const name = refName(ref);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names.join(' | ').slice(0, 1000);
}

function normalizeAmount(txn, type) {
  if (txn.TotalAmt !== undefined && txn.TotalAmt !== null) return Number(txn.TotalAmt) || 0;
  if (txn.Amount !== undefined && txn.Amount !== null) return Number(txn.Amount) || 0;
  const lineTotal = (txn.Line || []).reduce((sum, line) => sum + (Number(line.Amount) || 0), 0);
  if (lineTotal) return lineTotal;
  if (type === 'Payment' && txn.TotalAmt) return Number(txn.TotalAmt) || 0;
  return 0;
}

function vendorName(txn, type) {
  const line = firstLine(txn, () => true);
  return refName(txn.EntityRef)
    || refName(txn.VendorRef)
    || refName(txn.CustomerRef)
    || refName(txn.PayeeRef)
    || refName(txn.DepartmentRef)
    || refName(line.DepositLineDetail?.Entity)
    || refName(line.JournalEntryLineDetail?.Entity)
    || '';
}

function descriptionFor(txn) {
  return txn.PrivateNote || txn.Memo || txn.CustomerMemo?.value || txn.CustomerMemo || lineDescriptions(txn) || '';
}

function normalizeTransaction(txn, type, { firmId, realmId }) {
  const docNumber = txn.DocNumber || txn.PaymentRefNum || txn.CheckPayment?.PrintStatus || '';
  const memo = txn.PrivateNote || txn.Memo || txn.CustomerMemo?.value || txn.CustomerMemo || '';
  const paymentType = txn.PaymentType || txn.CheckPayment ? txn.PaymentType || 'Check' : '';
  const qboTxnType = paymentType === 'Check' && type === 'Purchase' ? 'Check' : type;
  const account = lineAccounts(txn);
  const description = descriptionFor(txn);

  return {
    firmId,
    realmId,
    qbId: String(txn.Id || ''),
    txnType: qboTxnType,
    date: txn.TxnDate || txn.MetaData?.CreateTime?.slice(0, 10) || '',
    amount: normalizeAmount(txn, type),
    description,
    vendorName: vendorName(txn, type),
    originalAccount: account,
    codedAccount: account,
    docNumber: String(docNumber || ''),
    memo: String(memo || ''),
    qboTxnType: type,
    qboRaw: txn,
  };
}

async function fetchAllQboRows(realmId, type, startDate) {
  const rows = [];
  let startPosition = 1;
  while (true) {
    const query = `SELECT * FROM ${type} WHERE TxnDate >= '${startDate}' STARTPOSITION ${startPosition} MAXRESULTS ${QBO_PAGE_SIZE}`;
    const data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}&minorversion=75`);
    const batch = data.QueryResponse?.[type] || [];
    rows.push(...batch);
    if (batch.length < QBO_PAGE_SIZE) break;
    startPosition += QBO_PAGE_SIZE;
  }
  return rows;
}

async function upsertTransaction(txn) {
  const result = await pool.query(
    `INSERT INTO transactions (
       firm_id, realm_id, qb_id, txn_type, date, amount, description, vendor_name,
       original_account, status, coded_account, coded_by, coded_at,
       doc_number, memo, qbo_txn_type, qbo_raw, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'categorized',$10,'qbo_backfill',NOW(),$11,$12,$13,$14::jsonb,NOW())
     ON CONFLICT (realm_id, qb_id) DO UPDATE SET
       firm_id = EXCLUDED.firm_id,
       txn_type = EXCLUDED.txn_type,
       date = EXCLUDED.date,
       amount = EXCLUDED.amount,
       description = EXCLUDED.description,
       vendor_name = EXCLUDED.vendor_name,
       original_account = EXCLUDED.original_account,
       coded_account = EXCLUDED.coded_account,
       doc_number = EXCLUDED.doc_number,
       memo = EXCLUDED.memo,
       qbo_txn_type = EXCLUDED.qbo_txn_type,
       qbo_raw = EXCLUDED.qbo_raw,
       updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [
      txn.firmId,
      txn.realmId,
      txn.qbId,
      txn.txnType,
      txn.date,
      txn.amount,
      txn.description,
      txn.vendorName,
      txn.originalAccount,
      txn.codedAccount,
      txn.docNumber,
      txn.memo,
      txn.qboTxnType,
      JSON.stringify(txn.qboRaw || {}),
    ]
  );
  return result.rows[0]?.inserted ? 'inserted' : 'updated';
}

async function backfillCompanyTransactions({ firmId, companyId = null, realmId = null, months = 24, types = null }) {
  const params = [firmId];
  let predicate;
  if (companyId) {
    params.push(companyId);
    predicate = 'id = $2';
  } else if (realmId) {
    params.push(realmId);
    predicate = 'realm_id = $2';
  } else {
    const err = new Error('companyId or realmId is required');
    err.statusCode = 400;
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT id, firm_id, company_name, realm_id
     FROM companies
     WHERE firm_id = $1 AND ${predicate}
     LIMIT 1`,
    params
  );
  const company = rows[0];
  if (!company) {
    const err = new Error('Company not found');
    err.statusCode = 404;
    throw err;
  }

  const startDate = monthsAgoDate(months);
  const selectedTypes = safeTypes(types);
  const byType = {};
  let inserted = 0;
  let updated = 0;
  let fetched = 0;
  const errors = [];

  for (const type of selectedTypes) {
    try {
      const txns = await fetchAllQboRows(company.realm_id, type, startDate);
      byType[type] = { fetched: txns.length, inserted: 0, updated: 0 };
      fetched += txns.length;
      for (const raw of txns) {
        if (!raw?.Id) continue;
        const normalized = normalizeTransaction(raw, type, { firmId, realmId: company.realm_id });
        const result = await upsertTransaction(normalized);
        if (result === 'inserted') {
          inserted++;
          byType[type].inserted++;
        } else {
          updated++;
          byType[type].updated++;
        }
      }
    } catch (err) {
      errors.push({ type, error: err.message });
      byType[type] = { fetched: 0, inserted: 0, updated: 0, error: err.message };
    }
  }

  await pool.query('UPDATE companies SET last_sync_at = NOW() WHERE firm_id = $1 AND realm_id = $2', [firmId, company.realm_id]);

  return {
    company,
    start_date: startDate,
    months: Number(months) || 24,
    types: selectedTypes,
    fetched,
    inserted,
    updated,
    errors,
    by_type: byType,
  };
}

module.exports = { backfillCompanyTransactions, DEFAULT_TYPES };
