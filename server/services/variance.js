const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

// Helper: parse QBO P&L report rows into { accountName: {amount, isIncome} } map
// isIncome=true for Income accounts, false for Expense accounts
function parsePnlRows(rows, isIncome = null) {
  const result = {};
  if (!rows) return result;

  for (const row of rows) {
    if (row.type === 'Section' || row.group) {
      const sectionName = (row.Header?.ColData?.[0]?.value || '').toLowerCase();
      // Detect top-level section type
      let childIsIncome = isIncome;
      if (isIncome === null) {
        if (/income|revenue|sales/.test(sectionName)) childIsIncome = true;
        else if (/expense|cost|cogs/.test(sectionName)) childIsIncome = false;
      }
      // Recurse into sub-rows
      if (row.Rows?.Row) {
        const sub = parsePnlRows(row.Rows.Row, childIsIncome);
        Object.assign(result, sub);
      }
      // Summary/total row
      if (row.Summary?.ColData) {
        const name = row.Summary.ColData[0]?.value || sectionName;
        const amt = parseFloat(row.Summary.ColData[1]?.value || '0');
        if (name) result['TOTAL: ' + name] = { amount: amt, isIncome: childIsIncome };
      }
    } else if (row.ColData) {
      const name = row.ColData[0]?.value || '';
      const amt = parseFloat(row.ColData[1]?.value || '0');
      if (name) result[name] = { amount: amt, isIncome };
    }
  }
  return result;
}

// Run P&L variance analysis comparing current period to prior month and same month last year
async function scanVariance(realmId, options = {}) {
  const now = new Date();
  const year = options.year || now.getFullYear();
  const month = options.month || now.getMonth() + 1;

  const thresholdPct = options.thresholdPct || 15;
  const thresholdAmt = options.thresholdAmt || 500;

  // Current month dates
  const curStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const curEnd = lastDay(year, month);

  // Prior month
  const priorDate = new Date(year, month - 2, 1);
  const priorYear = priorDate.getFullYear();
  const priorMonth = priorDate.getMonth() + 1;
  const priorStart = `${priorYear}-${String(priorMonth).padStart(2, '0')}-01`;
  const priorEnd = lastDay(priorYear, priorMonth);

  // Same month last year
  const yoyStart = `${year - 1}-${String(month).padStart(2, '0')}-01`;
  const yoyEnd = lastDay(year - 1, month);

  // Fetch all three P&L reports in parallel
  const [curPnl, priorPnl, yoyPnl] = await Promise.all([
    qbFetch(realmId, `/reports/ProfitAndLoss?start_date=${curStart}&end_date=${curEnd}&minorversion=75`).catch(() => null),
    qbFetch(realmId, `/reports/ProfitAndLoss?start_date=${priorStart}&end_date=${priorEnd}&minorversion=75`).catch(() => null),
    qbFetch(realmId, `/reports/ProfitAndLoss?start_date=${yoyStart}&end_date=${yoyEnd}&minorversion=75`).catch(() => null),
  ]);

  const curData = curPnl?.Rows?.Row ? parsePnlRows(curPnl.Rows.Row) : {};
  const priorData = priorPnl?.Rows?.Row ? parsePnlRows(priorPnl.Rows.Row) : {};
  const yoyData = yoyPnl?.Rows?.Row ? parsePnlRows(yoyPnl.Rows.Row) : {};

  // Compare current vs prior month
  const allAccounts = new Set([...Object.keys(curData), ...Object.keys(priorData), ...Object.keys(yoyData)]);
  const variances = [];

  for (const acct of allAccounts) {
    const curEntry = curData[acct] || { amount: 0, isIncome: null };
    const priorEntry = priorData[acct] || { amount: 0, isIncome: null };
    const yoyEntry = yoyData[acct] || { amount: 0, isIncome: null };
    const cur = typeof curEntry === 'object' ? curEntry.amount : curEntry;
    const prior = typeof priorEntry === 'object' ? priorEntry.amount : priorEntry;
    const yoy = typeof yoyEntry === 'object' ? yoyEntry.amount : yoyEntry;
    const isIncome = curEntry.isIncome ?? priorEntry.isIncome ?? yoyEntry.isIncome ?? null;

    // Month-over-month variance
    const momDiff = cur - prior;
    const momPct = prior !== 0 ? ((momDiff / Math.abs(prior)) * 100) : (cur !== 0 ? 100 : 0);

    // Year-over-year variance
    const yoyDiff = cur - yoy;
    const yoyPct = yoy !== 0 ? ((yoyDiff / Math.abs(yoy)) * 100) : (cur !== 0 ? 100 : 0);

    const momFlagged = Math.abs(momPct) >= thresholdPct && Math.abs(momDiff) >= thresholdAmt;
    const yoyFlagged = Math.abs(yoyPct) >= thresholdPct && Math.abs(yoyDiff) >= thresholdAmt;

    variances.push({
      account: acct,
      isIncome,
      current: cur,
      priorMonth: prior,
      priorYearMonth: yoy,
      momDiff,
      momPct: Math.round(momPct * 10) / 10,
      yoyDiff,
      yoyPct: Math.round(yoyPct * 10) / 10,
      momFlagged,
      yoyFlagged,
      flagged: momFlagged || yoyFlagged,
    });
  }

  // Sort: flagged first, then by absolute MoM diff
  variances.sort((a, b) => {
    if (a.flagged !== b.flagged) return b.flagged - a.flagged;
    return Math.abs(b.momDiff) - Math.abs(a.momDiff);
  });

  const flagged = variances.filter(v => v.flagged);

  const result = {
    period: `${year}-${String(month).padStart(2, '0')}`,
    priorPeriod: `${priorYear}-${String(priorMonth).padStart(2, '0')}`,
    yoyPeriod: `${year - 1}-${String(month).padStart(2, '0')}`,
    thresholdPct,
    thresholdAmt,
    summary: {
      totalAccounts: variances.length,
      flaggedCount: flagged.length,
      largestMomVariance: flagged.length > 0 ? flagged[0].account : null,
    },
    variances,
  };

  // Store scan result
  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'variance', $2, $3, $4)
  `, [realmId, result.period, JSON.stringify(result), flagged.length]);

  return result;
}

function lastDay(year, month) {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { scanVariance };
