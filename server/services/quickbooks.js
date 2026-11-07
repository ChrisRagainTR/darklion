const { pool } = require('../db');
const { getAccessToken } = require('./qboTokens');

const QB_BASE = 'https://quickbooks.api.intuit.com/v3/company';

async function qbFetch(realmId, endpoint, options = {}) {
  const token = await getAccessToken(realmId);
  const url = `${QB_BASE}/${realmId}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QB API ${res.status}: ${body}`);
  }

  return res.json();
}

// Pull uncategorized purchases from QuickBooks
async function syncTransactions(realmId) {
  const { rows: [job] } = await pool.query(
    "INSERT INTO jobs (realm_id, job_type) VALUES ($1, 'sync') RETURNING id",
    [realmId]
  );
  const jobId = job.id;

  try {
    const lastSync = await getLastSyncDate(realmId);
    const query = `SELECT * FROM Purchase WHERE MetaData.LastUpdatedTime > '${lastSync}' MAXRESULTS 500`;
    const data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}`);

    const purchases = data.QueryResponse?.Purchase || [];

    for (const txn of purchases) {
      const line = txn.Line?.[0] || {};
      const vendorRef = txn.EntityRef?.name || '';
      const accountRef = line.AccountBasedExpenseLineDetail?.AccountRef?.name || '';
      const desc = line.Description || txn.PrivateNote || '';

      await pool.query(`
        INSERT INTO transactions (realm_id, qb_id, txn_type, date, amount, description, vendor_name, original_account)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(realm_id, qb_id) DO UPDATE SET
          date = EXCLUDED.date,
          amount = EXCLUDED.amount,
          description = EXCLUDED.description,
          vendor_name = EXCLUDED.vendor_name,
          original_account = EXCLUDED.original_account,
          updated_at = NOW()
      `, [realmId, txn.Id, 'Purchase', txn.TxnDate || '', txn.TotalAmt || 0, desc, vendorRef, accountRef]);
    }

    await pool.query("UPDATE companies SET last_sync_at = NOW() WHERE realm_id = $1", [realmId]);

    await pool.query(
      "UPDATE jobs SET status = 'completed', items_processed = $1, items_total = $2, completed_at = NOW() WHERE id = $3",
      [purchases.length, purchases.length, jobId]
    );

    return { synced: purchases.length };
  } catch (err) {
    await pool.query(
      "UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
      [err.message, jobId]
    );
    throw err;
  }
}

// Get chart of accounts for categorization context
async function getChartOfAccounts(realmId) {
  const data = await qbFetch(realmId, `/query?query=${encodeURIComponent('SELECT * FROM Account MAXRESULTS 500')}`);
  return data.QueryResponse?.Account || [];
}

// Get vendor list
async function getVendors(realmId) {
  const data = await qbFetch(realmId, `/query?query=${encodeURIComponent('SELECT * FROM Vendor MAXRESULTS 500')}`);
  return data.QueryResponse?.Vendor || [];
}

// Map QBO transaction type names to API entity names
const TXN_TYPE_MAP = {
  'expense':              'purchase',
  'purchase':             'purchase',
  'credit card credit':   'purchase',
  'credit card charge':   'purchase',
  'creditcardcharge':     'purchase',
  'cashpurchase':         'purchase',
  'bill':                 'bill',
  'bill payment':         'billpayment',
  'check':                'purchase',
  'journal entry':        'journalentry',
  'journalentry':         'journalentry',
  'sales receipt':        'salesreceipt',
  'salesreceipt':         'salesreceipt',
  'invoice':              'invoice',
  'credit memo':          'creditmemo',
  'creditmemo':           'creditmemo',
  'vendor credit':        'vendorcredit',
  'vendorcredit':         'vendorcredit',
  'deposit':              'deposit',
  'transfer':             'transfer',
  'refundreceipt':        'refundreceipt',
};

// Write back a categorized transaction to QuickBooks
async function writeBackTransaction(realmId, qbId, accountName, txnType, opts = {}) {
  // Look up account ID by name first
  const accounts = await getChartOfAccounts(realmId);
  const account = accounts.find(a => a.Name === accountName || a.FullyQualifiedName === accountName);
  if (!account) throw new Error(`Account "${accountName}" not found in chart of accounts`);

  // Determine entity type from txnType
  const entityType = (txnType ? TXN_TYPE_MAP[txnType.toLowerCase()] : null) || 'purchase';
  console.log(`[recode] txnId=${qbId} txnType=${txnType} → entity=${entityType} account=${accountName}`);

  // Fetch the transaction
  const data = await qbFetch(realmId, `/${entityType}/${qbId}?minorversion=75`);
  const txnKey = Object.keys(data).find(k => k !== 'time');
  const txn = data[txnKey];

  if (!txn) throw new Error(`Transaction ${qbId} (type: ${entityType}) not found`);

  const purchase = txn; // use generic name

  // Update account reference based on transaction type
  if (entityType === 'purchase' || entityType === 'check') {
    // Purchase/Expense/Check: update Line[0] AccountBasedExpenseLineDetail
    const line = purchase.Line?.find(l => l.AccountBasedExpenseLineDetail);
    if (line) {
      line.AccountBasedExpenseLineDetail.AccountRef = { value: account.Id, name: account.Name };
    } else if (purchase.Line?.[0]) {
      purchase.Line[0].AccountBasedExpenseLineDetail = {
        AccountRef: { value: account.Id, name: account.Name }
      };
    }
  } else if (entityType === 'deposit') {
    // Deposit: update the matching line's DepositLineDetail.AccountRef.
    // Prefer the original uncategorized account when provided, otherwise fall back to the first deposit line.
    const targetOriginalAccount = (opts.originalAccount || '').trim();
    let line = null;

    if (targetOriginalAccount) {
      line = purchase.Line?.find(l => {
        const refName = l.DepositLineDetail?.AccountRef?.name || '';
        return refName === targetOriginalAccount;
      });
    }

    if (!line) {
      line = purchase.Line?.find(l => l.DepositLineDetail);
    }

    if (line) {
      line.DepositLineDetail.AccountRef = { value: account.Id, name: account.Name };
    } else {
      throw new Error(`No editable deposit line found for transaction ${qbId}`);
    }
  } else if (entityType === 'journalentry') {
    // Journal Entry: update the debit line's AccountRef
    const debitLine = purchase.Line?.find(l => l.JournalEntryLineDetail?.PostingType === 'Debit');
    if (debitLine) debitLine.JournalEntryLineDetail.AccountRef = { value: account.Id, name: account.Name };
  } else if (entityType === 'bill') {
    const line = purchase.Line?.find(l => l.AccountBasedExpenseLineDetail);
    if (line) line.AccountBasedExpenseLineDetail.AccountRef = { value: account.Id, name: account.Name };
  } else if (entityType === 'transfer') {
    // Transfers can't be recoded — they move money between accounts, not to expense/income
    throw new Error(`Transfers cannot be recoded — reclassify manually in QBO`);
  } else {
    throw new Error(`Recode not supported for transaction type: ${txnType}`);
  }

  // Write back
  // Write back using correct entity endpoint
  await qbFetch(realmId, `/${entityType}`, {
    method: 'POST',
    body: JSON.stringify(purchase),
  });

  // Update local status if tracked
  await pool.query(
    "UPDATE transactions SET status = 'written_back', updated_at = NOW() WHERE realm_id = $1 AND qb_id = $2",
    [realmId, qbId]
  ).catch(() => {}); // non-fatal if not in local DB

  return { ok: true };
}

async function getLastSyncDate(realmId) {
  const { rows } = await pool.query('SELECT last_sync_at FROM companies WHERE realm_id = $1', [realmId]);
  if (rows[0]?.last_sync_at) return rows[0].last_sync_at;
  // Default: 90 days ago
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().split('T')[0];
}

module.exports = { qbFetch, syncTransactions, getChartOfAccounts, getVendors, writeBackTransaction };
