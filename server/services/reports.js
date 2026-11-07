const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

function lastDayOfMonth(year, month) {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function defaultClosePackageYear(now = new Date()) {
  return now.getFullYear() - 1;
}

function defaultClosePackagePeriod(now = new Date()) {
  return String(defaultClosePackageYear(now));
}

function dateRangeForPeriod(period) {
  const normalized = String(period || defaultClosePackagePeriod()).trim();

  if (/^\d{4}$/.test(normalized)) {
    const year = Number(normalized);
    return {
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      monthStart: `${year}-01-01`,
    };
  }

  if (/^\d{4}-\d{2}$/.test(normalized)) {
    const [year, month] = normalized.split('-').map(Number);
    return {
      startDate: `${year}-01-01`,
      endDate: lastDayOfMonth(year, month),
      monthStart: `${year}-${String(month).padStart(2, '0')}-01`,
    };
  }

  throw new Error(`Unsupported close package period: ${normalized}`);
}

// Generate a close package for a period or custom date range
async function generateClosePackage(realmId, period, customStart, customEnd) {
  let startDate, endDate, monthStart;
  const normalizedPeriod = String(period || defaultClosePackagePeriod()).trim();

  if (customStart && customEnd) {
    // Custom date range
    startDate = customStart;
    endDate = customEnd;
    monthStart = customStart;
  } else {
    ({ startDate, endDate, monthStart } = dateRangeForPeriod(normalizedPeriod));
  }

  // Fetch reports in parallel — capture errors individually so we get real error messages
  const [pnlResult, bsResult, tbResult] = await Promise.all([
    qbFetch(realmId, `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&summarize_column_by=Month&minorversion=75`).then(d => ({ ok: true, data: d })).catch(e => ({ ok: false, error: e.message })),
    qbFetch(realmId, `/reports/BalanceSheet?start_date=${monthStart}&end_date=${endDate}&minorversion=75`).then(d => ({ ok: true, data: d })).catch(e => ({ ok: false, error: e.message })),
    qbFetch(realmId, `/reports/TrialBalance?start_date=${monthStart}&end_date=${endDate}&minorversion=75`).then(d => ({ ok: true, data: d })).catch(e => ({ ok: false, error: e.message })),
  ]);

  // If all three failed, throw the first error so the caller knows what went wrong
  if (!pnlResult.ok && !bsResult.ok && !tbResult.ok) {
    throw new Error(`QBO reports failed: ${pnlResult.error}`);
  }

  const pnlData = pnlResult.ok ? pnlResult.data : null;
  const bsData = bsResult.ok ? bsResult.data : null;
  const tbData = tbResult.ok ? tbResult.data : null;

  // Get latest uncategorized scan
  const { rows: scans } = await pool.query(`
    SELECT scan_type, result_data, flag_count, scanned_at
    FROM scan_results
    WHERE realm_id = $1 AND scan_type = 'uncategorized'
    AND scanned_at > NOW() - INTERVAL '30 days'
    ORDER BY scanned_at DESC
    LIMIT 1
  `, [realmId]);

  const latestUncatScan = scans[0] || null;

  const reportData = {
    period: normalizedPeriod,
    generatedAt: new Date().toISOString(),
    pnl: pnlData,
    balanceSheet: bsData,
    trialBalance: tbData,
    checklist: [
      { item: 'P&L by Month', status: pnlData ? 'ok' : 'missing' },
      { item: 'Balance Sheet', status: bsData ? 'ok' : 'missing' },
      { item: 'Trial Balance', status: tbData ? 'ok' : 'missing' },
      {
        item: 'Uncategorized Scan',
        status: latestUncatScan ? (latestUncatScan.flag_count > 0 ? 'warning' : 'ok') : 'not_run',
        flagCount: latestUncatScan?.flag_count || 0,
      },
    ],
  };

  const { rows: existing } = await pool.query(
    `SELECT id FROM close_packages
     WHERE realm_id = $1 AND period = $2
     ORDER BY generated_at DESC
     LIMIT 1`,
    [realmId, normalizedPeriod]
  );

  if (existing[0]) {
    const { rows: [pkg] } = await pool.query(`
      UPDATE close_packages
      SET report_data = $3, generated_at = NOW(), status = 'draft'
      WHERE id = $1 AND realm_id = $2
      RETURNING *
    `, [existing[0].id, realmId, JSON.stringify(reportData)]);
    return pkg;
  }

  const { rows: [pkg] } = await pool.query(`
    INSERT INTO close_packages (realm_id, period, report_data)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [realmId, normalizedPeriod, JSON.stringify(reportData)]);

  return pkg;
}

async function generateDefaultClosePackage(realmId, now = new Date()) {
  return generateClosePackage(realmId, defaultClosePackagePeriod(now));
}

module.exports = {
  generateClosePackage,
  generateDefaultClosePackage,
  defaultClosePackageYear,
  defaultClosePackagePeriod,
};
