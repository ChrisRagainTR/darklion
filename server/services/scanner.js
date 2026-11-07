const { pool } = require('../db');
const { getChartOfAccounts, qbFetch } = require('./quickbooks');

// Scan for uncategorized transaction accounts
// Uses GeneralLedger report API for accurate transaction counts (not just balance)
async function scanUncategorized(realmId) {
  const targetNames = ['Uncategorized Income', 'Uncategorized Expense', 'Ask My Accountant'];
  const accounts = await getChartOfAccounts(realmId);

  const flagged = [];
  const checked = [];

  // Look back 90 days for transactions
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - 90);
  const startDate = sinceDate.toISOString().split('T')[0];
  const endDate = new Date().toISOString().split('T')[0];

  for (const name of targetNames) {
    const acct = accounts.find(a =>
      (a.Name || '').toLowerCase() === name.toLowerCase() ||
      (a.FullyQualifiedName || '').toLowerCase() === name.toLowerCase()
    );

    if (!acct) continue;

    const balance = Number(acct.CurrentBalance || 0);

    // Use GeneralLedger report to get actual transactions in this account
    let transactions = [];
    try {
      const params = `start_date=${startDate}&end_date=${endDate}&account=${acct.Id}&columns=tx_date,txn_type,doc_num,memo,amount,vend_name&minorversion=75`;
      const data = await qbFetch(realmId, `/reports/GeneralLedger?${params}`);
      const noData = data.Header?.Option?.find(o => o.Name === 'NoReportData')?.Value;

      if (noData !== 'true') {
        const sections = data.Rows?.Row || [];
        for (const section of sections) {
          const txnRows = section.Rows?.Row || [];
          for (const row of txnRows) {
            if (row.type !== 'Data') continue;
            const cols = row.ColData || [];
            const txnDate = cols[0]?.value || '';
            const txnType = cols[1]?.value || '';
            const vendor = cols[3]?.value || '';
            const memo = cols[4]?.value || '';
            const amountStr = cols[5]?.value || cols[6]?.value || '0';
            const amount = parseFloat(amountStr.replace(/[,$]/g, '')) || 0;

            if (!txnDate) continue;

            transactions.push({
              date: txnDate,
              description: (memo || '').substring(0, 80),
              vendor: vendor,
              amount: Math.abs(amount),
            });
          }
        }
      }
    } catch (e) {
      // Non-fatal — fall back to balance-only check
      console.warn(`[scanner] GeneralLedger query failed for ${acct.Name}: ${e.message}`);
    }

    checked.push({
      name: acct.Name,
      id: acct.Id,
      balance,
      type: acct.AccountType,
      transactionCount: transactions.length,
    });

    // Flag if there are ANY transactions (not just non-zero balance)
    if (transactions.length > 0 || balance !== 0) {
      const totalAmount = transactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);
      flagged.push({
        name: acct.Name,
        id: acct.Id,
        balance,
        type: acct.AccountType,
        transactionCount: transactions.length,
        totalAmount,
        transactions,
      });
    }
  }

  const totalFlaggedAmount = flagged.reduce((sum, f) => sum + (f.totalAmount || Math.abs(f.balance)), 0);
  const totalTransactions = flagged.reduce((sum, f) => sum + (f.transactionCount || 0), 0);

  const result = {
    flagged,
    checked,
    summary: {
      flaggedCount: flagged.length,
      checkedCount: checked.length,
      totalFlaggedAmount,
      totalTransactions,
    },
  };

  // Store scan result
  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'uncategorized', $2, $3, $4)
  `, [realmId, currentPeriod(), JSON.stringify(result), flagged.length]);

  return result;
}

// Get the latest scan result for a given type
async function getLatestScan(realmId, scanType) {
  const { rows } = await pool.query(`
    SELECT * FROM scan_results
    WHERE realm_id = $1 AND scan_type = $2
    ORDER BY scanned_at DESC LIMIT 1
  `, [realmId, scanType]);
  return rows[0] || null;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { scanUncategorized, getLatestScan };
