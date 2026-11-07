'use strict';

// revenueSync.js
// Fetches last 12 months P&L from QBO for a company and stores total income
// in companies.annual_revenue.

const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

// Extract total income from QBO P&L report data
function extractTotalIncome(pnl) {
  if (!pnl || !pnl.Rows) return null;
  // Walk the top-level rows looking for the Income section summary
  const rows = pnl.Rows.Row || [];
  for (const section of rows) {
    // Income section has type="Section" with a Summary row
    if (section.type === 'Section' && section.Summary) {
      const colData = section.Summary.ColData || [];
      const label = (colData[0]?.value || '').toLowerCase();
      if (label.includes('total income') || label.includes('gross profit') || label === 'total revenue') {
        // Last ColData value is the total (rightmost column = full period total)
        const lastCol = colData[colData.length - 1];
        const val = parseFloat(lastCol?.value);
        if (!isNaN(val)) return val;
      }
    }
  }
  // Fallback: look for a row with "Total Income" anywhere
  function walk(rows) {
    for (const row of (rows || [])) {
      if (row.Summary) {
        const label = (row.Summary.ColData?.[0]?.value || '').toLowerCase();
        if (label.includes('total income') || label.includes('total revenue')) {
          const cols = row.Summary.ColData || [];
          const val = parseFloat(cols[cols.length - 1]?.value);
          if (!isNaN(val)) return val;
        }
      }
      if (row.Rows) {
        const found = walk(row.Rows.Row);
        if (found !== null) return found;
      }
    }
    return null;
  }
  return walk(rows);
}

// Sync annual revenue for a single company by realm_id
async function syncCompanyRevenue(realmId) {
  try {
    const now = new Date();
    const endDate = now.toISOString().slice(0, 10);
    const startDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
      .toISOString().slice(0, 10);

    const pnl = await qbFetch(
      realmId,
      `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&summarize_column_by=Total&minorversion=75`
    );

    const revenue = extractTotalIncome(pnl);
    if (revenue === null) {
      console.log(`[revenue-sync] No income found for ${realmId}`);
      return null;
    }

    await pool.query(
      'UPDATE companies SET annual_revenue=$1, annual_revenue_synced_at=NOW() WHERE realm_id=$2',
      [Math.round(revenue * 100) / 100, realmId]
    );
    console.log(`[revenue-sync] ${realmId}: $${revenue.toLocaleString()}/yr`);
    return revenue;
  } catch(e) {
    console.error(`[revenue-sync] Error for ${realmId}:`, e.message);
    return null;
  }
}

// Sync all QBO-connected companies for a firm
async function syncAllCompanyRevenue(firmId) {
  const { rows } = await pool.query(
    `SELECT realm_id FROM companies
     WHERE firm_id=$1
       AND realm_id IS NOT NULL
       AND realm_id != ''
       AND realm_id NOT LIKE 'import-%'
       AND refresh_token != ''`,
    [firmId]
  );
  for (const row of rows) {
    await syncCompanyRevenue(row.realm_id).catch(e =>
      console.error(`[revenue-sync] ${row.realm_id}:`, e.message)
    );
  }
}

module.exports = { syncCompanyRevenue, syncAllCompanyRevenue };
