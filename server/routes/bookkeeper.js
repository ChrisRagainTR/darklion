'use strict';

/**
 * bookkeeper.js — Auto-Bookkeeper API routes
 *
 * DASHBOARD
 * GET  /api/bookkeeper/overview                        — summary stats
 * GET  /api/bookkeeper/companies                       — QBO-connected companies + toggle state
 * POST /api/bookkeeper/toggle                          — enable/disable auto-bookkeeper per company
 *
 * UNCODED TRANSACTIONS
 * GET  /api/bookkeeper/uncoded                         — firm-wide pending transactions
 * GET  /api/bookkeeper/snoozed                         — firm-wide snoozed transactions
 * GET  /api/bookkeeper/company/:companyId/uncoded      — per-company pending transactions
 * POST /api/bookkeeper/code                            — code a single transaction → QBO
 * POST /api/bookkeeper/code-bulk                       — code multiple transactions → QBO
 * POST /api/bookkeeper/snooze                          — snooze a transaction for N days
 *
 * SENT TO CLIENT
 * POST /api/bookkeeper/company/:companyId/send-to-client — mark txns as sent to client
 * GET  /api/bookkeeper/sent-to-client                  — firm-wide: all pending client questions grouped by person
 * GET  /api/bookkeeper/company/:companyId/sent-to-client — per-company sent-to-client list (used by CRM)
 *
 * VENDOR MAPPINGS
 * GET  /api/bookkeeper/mappings                        — list vendor mappings
 * POST /api/bookkeeper/mappings                        — add/update a mapping
 * DELETE /api/bookkeeper/mappings/:id                  — delete a mapping
 * GET  /api/bookkeeper/company/:companyId/mappings     — per-company mappings
 * POST /api/bookkeeper/rebuild-mapping                 — manually rebuild mapping from 24-month history
 *
 * RUNS
 * GET  /api/bookkeeper/runs                            — recent run history (firm-wide)
 * GET  /api/bookkeeper/runs/:runId/transactions        — transactions from a specific run
 * GET  /api/bookkeeper/company/:companyId/runs         — per-company run history
 * GET  /api/bookkeeper/history                         — full coding history
 * POST /api/bookkeeper/scan-only                       — pull from QBO into DB, no AI coding
 * POST /api/bookkeeper/run-now                         — full AI coding run
 *
 * CHART OF ACCOUNTS
 * GET  /api/bookkeeper/chart-of-accounts               — QBO COA for dropdowns (grouped)
 *
 * DEV/TEST
 * POST /api/bookkeeper/test-bkq-email                  — send sample BKQ reminder email to self
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireFirm } = require('../middleware/requireFirm');
const { apiScopeAllowed } = require('../middleware/requireApiScope');
const { writeBackTransaction, getChartOfAccounts } = require('../services/quickbooks');
const { runBookkeeper, scanOnlyBookkeeper, rebuildVendorMapping, normalizeVendorName } = require('../services/bookkeeper');

function isAutoBookkeeperGloballyEnabled() {
  return String(process.env.AUTO_BOOKKEEPER_ENABLED || 'true').toLowerCase() !== 'false';
}

router.use((req, res, next) => {
  if (!req.firm?.isApiToken) return next();
  const scope = ['GET', 'HEAD'].includes(req.method) ? 'transactions_read' : 'transactions_write';
  if (apiScopeAllowed(req, scope)) return next();
  return res.status(403).json({ error: `API token scope required: ${scope}` });
});

// ── GET /api/bookkeeper/overview ─────────────────────────────
// Dashboard summary: pending count, recent runs
router.get('/overview', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  try {
    // Pending uncoded count — deduplicated by txn_qb_id + realm_id
    const { rows: pendingRows } = await pool.query(`
      SELECT COUNT(*) AS count, COUNT(DISTINCT realm_id) AS companies
      FROM (
        SELECT DISTINCT ON (realm_id, txn_qb_id) id, realm_id
        FROM bookkeeper_uncoded
        WHERE firm_id = $1 AND status = 'pending' AND (amount IS NOT NULL AND amount != 0)
        ORDER BY realm_id, txn_qb_id, run_id DESC
      ) deduped
    `, [firmId]);

    // Last 7 runs
    const { rows: runs } = await pool.query(`
      SELECT br.*, c.company_name
      FROM bookkeeper_runs br
      LEFT JOIN companies c ON c.realm_id = br.realm_id AND c.firm_id = br.firm_id
      WHERE br.firm_id = $1
      ORDER BY br.started_at DESC
      LIMIT 7
    `, [firmId]);

    // Total mappings
    const { rows: mappingCount } = await pool.query(
      'SELECT COUNT(*) AS count FROM vendor_mapping WHERE firm_id = $1',
      [firmId]
    );

    res.json({
      pendingCount: parseInt(pendingRows[0]?.count || 0),
      pendingCompanies: parseInt(pendingRows[0]?.companies || 0),
      recentRuns: runs,
      totalMappings: parseInt(mappingCount[0]?.count || 0),
    });
  } catch (err) {
    console.error('GET /api/bookkeeper/overview error:', err);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

// ── GET /api/bookkeeper/uncoded ──────────────────────────────
// All pending uncoded transactions, optionally filtered by company
router.get('/uncoded', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId, status: statusFilter, days, showSnoozed } = req.query;

  try {
    // Default to pending
    const status = statusFilter || 'pending';
    if (!['pending', 'coded', 'all'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    const dayCount = days === undefined ? null : Number(days);
    if (dayCount !== null && (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 3660)) {
      return res.status(400).json({ error: 'days must be an integer between 1 and 3660' });
    }

    // Wrap in DISTINCT ON to deduplicate same transaction across multiple runs
    const snoozeFilter = showSnoozed === 'only'
      ? 'WHERE snoozed_until IS NOT NULL AND snoozed_until > NOW()'
      : showSnoozed === 'true' ? ''
      : 'WHERE (snoozed_until IS NULL OR snoozed_until <= NOW())';

    const params = [firmId];
    const conditions = ['bu.firm_id = $1'];
    if (status !== 'all') {
      params.push(status);
      conditions.push(`bu.status = $${params.length}`);
    }
    if (realmId) {
      params.push(String(realmId));
      conditions.push(`bu.realm_id = $${params.length}`);
    }
    if (dayCount !== null) {
      params.push(dayCount);
      conditions.push(`bu.report_date >= CURRENT_DATE - $${params.length}::integer`);
    }

    // Dedup FIRST, then apply snooze filter so snoozed flag on latest run wins
    const dedupQuery = `
      SELECT deduped.*, c.company_name AS company
      FROM (
        SELECT DISTINCT ON (realm_id, txn_qb_id) bu.*
        FROM bookkeeper_uncoded bu
        WHERE ${conditions.join('\n          AND ')}
          AND (bu.amount IS NOT NULL AND bu.amount != 0)
        ORDER BY realm_id, txn_qb_id, run_id DESC, id DESC
      ) deduped
      LEFT JOIN companies c ON c.realm_id = deduped.realm_id AND c.firm_id = deduped.firm_id
      ${snoozeFilter}
    `;

    const { rows } = await pool.query(dedupQuery, params);

    // Sort after dedup
    rows.sort((a, b) => {
      const dateA = new Date(a.txn_date || a.report_date || 0);
      const dateB = new Date(b.txn_date || b.report_date || 0);
      if (dateB - dateA !== 0) return dateB - dateA;
      if ((a.company || '') < (b.company || '')) return -1;
      if ((a.company || '') > (b.company || '')) return 1;
      return Math.abs(parseFloat(b.amount)) - Math.abs(parseFloat(a.amount));
    });

    res.json({ transactions: rows });
  } catch (err) {
    console.error('GET /api/bookkeeper/uncoded error:', err);
    res.status(500).json({ error: 'Failed to fetch uncoded transactions' });
  }
});

// ── GET /api/bookkeeper/runs ─────────────────────────────────
// Recent run history with stats
router.get('/runs', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const limit = parseInt(req.query.limit) || 20;

  try {
    const { rows } = await pool.query(`
      SELECT br.*, c.company_name, c.id AS company_id
      FROM bookkeeper_runs br
      LEFT JOIN companies c ON c.realm_id = br.realm_id AND c.firm_id = br.firm_id
      WHERE br.firm_id = $1
      ORDER BY br.started_at DESC
      LIMIT $2
    `, [firmId, limit]);

    res.json({ runs: rows });
  } catch (err) {
    console.error('GET /api/bookkeeper/runs error:', err);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// ── POST /api/bookkeeper/code ────────────────────────────────
// Code a single uncoded transaction (writes to QBO + optionally saves mapping)
router.post('/code', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { uncodedId, accountName, saveMappingForVendor } = req.body;

  if (!uncodedId || !accountName) {
    return res.status(400).json({ error: 'uncodedId and accountName are required' });
  }

  try {
    // Fetch the uncoded record
    const { rows: uncoded } = await pool.query(
      'SELECT * FROM bookkeeper_uncoded WHERE id = $1 AND firm_id = $2',
      [uncodedId, firmId]
    );
    if (!uncoded.length) return res.status(404).json({ error: 'Transaction not found' });

    const txn = uncoded[0];

    // 1. Write back to QBO
    await writeBackTransaction(txn.realm_id, txn.txn_qb_id, accountName, txn.txn_type);

    // 2. Update uncoded record
    await pool.query(`
      UPDATE bookkeeper_uncoded
      SET status = 'coded', coded_account = $1, coded_at = NOW(), coded_by = $2
      WHERE id = $3
    `, [accountName, userId, uncodedId]);

    // 3. Update transactions table
    await pool.query(`
      UPDATE transactions
      SET status = 'categorized', coded_by = 'manual', coded_account = $1, coded_at = NOW()
      WHERE realm_id = $2 AND qb_id = $3
    `, [accountName, txn.realm_id, txn.txn_qb_id]).catch(() => {}); // non-fatal

    // 4. Save vendor mapping if requested
    if (saveMappingForVendor !== false && txn.vendor_name) {
      // Get account ID from chart of accounts
      let accountId = '';
      try {
        const accounts = await getChartOfAccounts(txn.realm_id);
        const matched = accounts.find(a => a.Name === accountName);
        accountId = matched?.Id || '';
      } catch (e) { /* non-fatal */ }

      const direction = (txn.original_account || '').toLowerCase().includes('income') ? 'income' : 'expense';
      await pool.query(`
        INSERT INTO vendor_mapping
          (realm_id, firm_id, vendor_name, vendor_name_normalized, direction, account_name, account_id, source, confidence, usage_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', 100, 1)
        ON CONFLICT (realm_id, vendor_name, direction) DO UPDATE SET
          account_name = EXCLUDED.account_name,
          account_id = EXCLUDED.account_id,
          source = 'manual',
          confidence = 100,
          usage_count = vendor_mapping.usage_count + 1,
          updated_at = NOW()
      `, [txn.realm_id, firmId, txn.vendor_name, normalizeVendorName(txn.vendor_name), direction, accountName, accountId]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/bookkeeper/code error:', err);
    res.status(500).json({ error: 'Failed to code transaction: ' + err.message });
  }
});

// ── POST /api/bookkeeper/code-bulk ───────────────────────────
// Code multiple transactions at once
router.post('/code-bulk', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { items } = req.body;

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items array required' });
  }

  let coded = 0, failed = 0;
  const errors = [];

  for (const item of items) {
    try {
      const { uncodedId, accountName, saveMappingForVendor } = item;
      if (!uncodedId || !accountName) { failed++; continue; }

      const { rows: uncoded } = await pool.query(
        'SELECT * FROM bookkeeper_uncoded WHERE id = $1 AND firm_id = $2 AND status = $3',
        [uncodedId, firmId, 'pending']
      );
      if (!uncoded.length) { failed++; continue; }
      const txn = uncoded[0];

      await writeBackTransaction(txn.realm_id, txn.txn_qb_id, accountName, txn.txn_type);

      await pool.query(
        `UPDATE bookkeeper_uncoded SET status = 'coded', coded_account = $1, coded_at = NOW(), coded_by = $2 WHERE id = $3`,
        [accountName, userId, uncodedId]
      );

      await pool.query(
        `UPDATE transactions SET status = 'categorized', coded_by = 'manual', coded_account = $1, coded_at = NOW() WHERE realm_id = $2 AND qb_id = $3`,
        [accountName, txn.realm_id, txn.txn_qb_id]
      ).catch(() => {});

      if (saveMappingForVendor !== false && txn.vendor_name) {
        const dir = (txn.original_account || '').toLowerCase().includes('income') ? 'income' : 'expense';
        await pool.query(`
          INSERT INTO vendor_mapping
            (realm_id, firm_id, vendor_name, vendor_name_normalized, direction, account_name, source, confidence, usage_count)
          VALUES ($1, $2, $3, $4, $5, $6, 'manual', 100, 1)
          ON CONFLICT (realm_id, vendor_name, direction) DO UPDATE SET
            account_name = EXCLUDED.account_name, source = 'manual', confidence = 100,
            usage_count = vendor_mapping.usage_count + 1, updated_at = NOW()
        `, [txn.realm_id, firmId, txn.vendor_name, normalizeVendorName(txn.vendor_name), dir, accountName]);
      }

      coded++;
    } catch (err) {
      failed++;
      errors.push(err.message);
    }
  }

  res.json({ success: true, coded, failed, errors: errors.slice(0, 5) });
});


// ── POST /api/bookkeeper/snooze ─────────────────────────────
// Snooze a transaction for N days (default 3)
router.post('/snooze', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { uncodedId, days } = req.body;
  if (!uncodedId) return res.status(400).json({ error: 'uncodedId required' });

  const snoozeDays = parseInt(days) || 3;
  try {
    const { rowCount } = await pool.query(
      `UPDATE bookkeeper_uncoded SET snoozed_until = NOW() + ($1 || ' days')::INTERVAL WHERE id = $2 AND firm_id = $3`,
      [snoozeDays, uncodedId, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/bookkeeper/snooze error:', err);
    res.status(500).json({ error: 'Failed to snooze transaction' });
  }
});

// ── GET /api/bookkeeper/mappings ─────────────────────────────
// Vendor mapping list
router.get('/mappings', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId, search } = req.query;

  try {
    let query = `
      SELECT vm.*, c.company_name
      FROM vendor_mapping vm
      LEFT JOIN companies c ON c.realm_id = vm.realm_id AND c.firm_id = vm.firm_id
      WHERE vm.firm_id = $1
    `;
    const params = [firmId];
    let paramIdx = 2;

    if (realmId) {
      query += ` AND vm.realm_id = $${paramIdx++}`;
      params.push(realmId);
    }

    if (search) {
      query += ` AND (vm.vendor_name ILIKE $${paramIdx} OR vm.account_name ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }

    query += ' ORDER BY vm.usage_count DESC, vm.vendor_name ASC';

    const { rows } = await pool.query(query, params);
    res.json({ mappings: rows });
  } catch (err) {
    console.error('GET /api/bookkeeper/mappings error:', err);
    res.status(500).json({ error: 'Failed to fetch mappings' });
  }
});

// ── POST /api/bookkeeper/mappings ────────────────────────────
// Add or update a vendor mapping
router.post('/mappings', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId, vendorName, accountName, accountId, notes, direction } = req.body;

  if (!realmId || !vendorName || !accountName) {
    return res.status(400).json({ error: 'realmId, vendorName, and accountName are required' });
  }

  const dir = direction === 'income' ? 'income' : 'expense';

  try {
    await pool.query(`
      INSERT INTO vendor_mapping
        (firm_id, realm_id, vendor_name, vendor_name_normalized, direction, account_name, account_id, source, confidence, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', 100, $8)
      ON CONFLICT (realm_id, vendor_name, direction) DO UPDATE SET
        account_name = EXCLUDED.account_name,
        account_id = EXCLUDED.account_id,
        source = 'manual',
        confidence = 100,
        notes = COALESCE(EXCLUDED.notes, vendor_mapping.notes),
        updated_at = NOW()
    `, [firmId, realmId, vendorName.trim(), normalizeVendorName(vendorName), dir, accountName, accountId || '', notes || '']);

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/bookkeeper/mappings error:', err);
    res.status(500).json({ error: 'Failed to save mapping' });
  }
});

// ── DELETE /api/bookkeeper/mappings/:id ──────────────────────
router.delete('/mappings/:id', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM vendor_mapping WHERE id = $1 AND firm_id = $2',
      [parseInt(id), firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Mapping not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/bookkeeper/mappings error:', err);
    res.status(500).json({ error: 'Failed to delete mapping' });
  }
});

// ── GET /api/bookkeeper/chart-of-accounts ────────────────────
// Get a company's chart of accounts for the account dropdown
router.get('/chart-of-accounts', requireFirm, async (req, res) => {
  const { realmId } = req.query;
  if (!realmId) return res.status(400).json({ error: 'realmId query param required' });

  try {
    const accounts = await getChartOfAccounts(realmId);
    // Filter to expense + income accounts (what you'd code transactions to)
    // Filter to relevant account types
    const relevant = accounts.filter(a =>
      ['Income', 'Other Income', 'Expense', 'Other Expense', 'Cost of Goods Sold', 'Equity'].includes(a.AccountType)
    );

    // Group and sort: Income first, then Expenses, then Equity
    const accountOrder = { 'Income': 1, 'Other Income': 1, 'Expense': 2, 'Other Expense': 2, 'Cost of Goods Sold': 2, 'Equity': 3 };
    relevant.sort((a, b) => {
      const orderA = accountOrder[a.AccountType] || 99;
      const orderB = accountOrder[b.AccountType] || 99;
      if (orderA !== orderB) return orderA - orderB;
      return (a.Name || '').localeCompare(b.Name || '');
    });

    // Add section headers for UI grouping
    const formatted = [];
    let lastGroup = null;
    const groupLabels = { 1: '─── Income ───', 2: '─── Expenses ───', 3: '─── Equity ───' };

    for (const a of relevant) {
      const group = accountOrder[a.AccountType] || 99;
      if (group !== lastGroup) {
        formatted.push({ id: '', name: groupLabels[group] || '', type: '_header', isHeader: true });
        lastGroup = group;
      }
      formatted.push({
        id: a.Id,
        name: a.Name,
        fullyQualifiedName: a.FullyQualifiedName,
        type: a.AccountType,
        subType: a.AccountSubType,
        isHeader: false,
      });
    }

    res.json({ accounts: formatted });
  } catch (err) {
    console.error('GET /api/bookkeeper/chart-of-accounts error:', err);
    res.status(500).json({ error: 'Failed to fetch chart of accounts: ' + err.message });
  }
});

// ── POST /api/bookkeeper/rebuild-mapping ─────────────────────
// Manually trigger mapping rebuild for a company
router.post('/rebuild-mapping', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId } = req.body;

  if (!realmId) return res.status(400).json({ error: 'realmId required' });

  try {
    const created = await rebuildVendorMapping(realmId, firmId);
    res.json({ success: true, mappingsCreated: created });
  } catch (err) {
    console.error('POST /api/bookkeeper/rebuild-mapping error:', err);
    res.status(500).json({ error: 'Failed to rebuild mapping: ' + err.message });
  }
});

// ── POST /api/bookkeeper/scan-only ──────────────────────────
// Pull uncategorized txns from QBO into bookkeeper_uncoded WITHOUT AI coding
router.post('/scan-only', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId } = req.body;
  if (!realmId) return res.status(400).json({ error: 'realmId required' });
  if (!isAutoBookkeeperGloballyEnabled()) {
    return res.status(403).json({ error: 'Auto-Bookkeeper is currently disabled.' });
  }
  try {
    const result = await scanOnlyBookkeeper(realmId, firmId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('POST /api/bookkeeper/scan-only error:', err);
    res.status(500).json({ error: 'Scan failed: ' + err.message });
  }
});

// ── POST /api/bookkeeper/run-now ────────────────────────────
// Manually trigger a full AI bookkeeper run for a company
router.post('/run-now', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId } = req.body;

  if (!realmId) return res.status(400).json({ error: 'realmId required' });
  if (!isAutoBookkeeperGloballyEnabled()) {
    return res.status(403).json({ error: 'Auto-Bookkeeper is currently disabled.' });
  }

  try {
    const { rows: companyRows } = await pool.query(
      `SELECT company_name, auto_bookkeeper_enabled
       FROM companies
       WHERE realm_id = $1 AND firm_id = $2
       LIMIT 1`,
      [realmId, firmId]
    );

    if (!companyRows.length) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const company = companyRows[0];
    if (!company.auto_bookkeeper_enabled) {
      return res.status(400).json({
        error: `Auto-Bookkeeper is not enabled for ${company.company_name || 'this company'}. Turn it on first, then rerun.`
      });
    }

    const result = await runBookkeeper(realmId, firmId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('POST /api/bookkeeper/run-now error:', err);
    res.status(500).json({ error: 'Bookkeeper run failed: ' + err.message });
  }
});

// ── GET /api/bookkeeper/companies ────────────────────────────
// List QBO-connected companies for filter dropdowns
router.get('/companies', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(`
      SELECT id, realm_id, company_name, auto_bookkeeper_enabled
      FROM companies
      WHERE firm_id = $1 AND realm_id IS NOT NULL AND realm_id != ''
      ORDER BY company_name ASC
    `, [firmId]);
    res.json({ companies: rows });
  } catch (err) {
    console.error('GET /api/bookkeeper/companies error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// ── GET /api/bookkeeper/snoozed ────────────────────────────────────
router.get('/snoozed', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId } = req.query;
  try {
    let q = `
      SELECT DISTINCT ON (realm_id, txn_qb_id) bu.*, c.company_name AS company
      FROM bookkeeper_uncoded bu
      LEFT JOIN companies c ON c.realm_id = bu.realm_id AND c.firm_id = bu.firm_id
      WHERE bu.firm_id = $1
        AND bu.status = 'pending'
        AND bu.snoozed_until > NOW()
        AND (bu.amount IS NOT NULL AND bu.amount != 0)
        ${realmId ? 'AND bu.realm_id = $2' : ''}
      ORDER BY realm_id, txn_qb_id, run_id DESC
    `;
    const params = realmId ? [firmId, realmId] : [firmId];
    const { rows } = await pool.query(q, params);
    rows.sort((a, b) => new Date(a.snoozed_until) - new Date(b.snoozed_until));
    res.json({ transactions: rows });
  } catch (err) {
    console.error('GET /api/bookkeeper/snoozed error:', err);
    res.status(500).json({ error: 'Failed to fetch snoozed transactions' });
  }
});

// ── GET /api/bookkeeper/company/:companyId/uncoded ───────────
// Uncoded transactions for a specific company
router.get('/company/:companyId/uncoded', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { companyId } = req.params;
  const { status: statusFilter, showSnoozed } = req.query;

  try {
    // Get realm_id for this company
    const { rows: companyRows } = await pool.query(
      'SELECT realm_id FROM companies WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    if (!companyRows.length) return res.status(404).json({ error: 'Company not found' });
    const realmId = companyRows[0].realm_id;

    const status = statusFilter || 'pending';
    const snoozeFilter = showSnoozed === 'only'
      ? 'WHERE snoozed_until IS NOT NULL AND snoozed_until > NOW()'
      : showSnoozed === 'true' ? ''
      : 'WHERE (snoozed_until IS NULL OR snoozed_until <= NOW())';

    // Dedup FIRST (pick most recent run per txn), THEN apply snooze filter
    const { rows } = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (txn_qb_id) bu.*
        FROM bookkeeper_uncoded bu
        WHERE bu.firm_id = $1 AND bu.realm_id = $2
          AND ($3::text = 'all' OR bu.status = $3)
          AND bu.sent_to_client = FALSE
          AND (bu.amount IS NOT NULL AND bu.amount != 0)
        ORDER BY txn_qb_id, run_id DESC, id DESC
      ) deduped
      ${snoozeFilter}
    `, [firmId, realmId, status]);

    // Sort results by txn_date desc, amount desc after dedup
    rows.sort((a, b) => {
      const dateA = new Date(a.txn_date || a.report_date || 0);
      const dateB = new Date(b.txn_date || b.report_date || 0);
      if (dateB - dateA !== 0) return dateB - dateA;
      return Math.abs(parseFloat(b.amount)) - Math.abs(parseFloat(a.amount));
    });

    res.json({ transactions: rows, realmId, companyId });
  } catch (err) {
    console.error('GET /api/bookkeeper/company/:companyId/uncoded error:', err);
    res.status(500).json({ error: 'Failed to fetch uncoded transactions' });
  }
});

// ── GET /api/bookkeeper/company/:companyId/mappings ──────────
// Vendor mappings for a specific company
router.get('/company/:companyId/mappings', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { companyId } = req.params;
  const { search } = req.query;

  try {
    const { rows: companyRows } = await pool.query(
      'SELECT realm_id, company_name FROM companies WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    if (!companyRows.length) return res.status(404).json({ error: 'Company not found' });
    const realmId = companyRows[0].realm_id;

    let query = `
      SELECT vm.*
      FROM vendor_mapping vm
      WHERE vm.firm_id = $1 AND vm.realm_id = $2
    `;
    const params = [firmId, realmId];
    let paramIdx = 3;

    if (search) {
      query += ` AND (vm.vendor_name ILIKE $${paramIdx} OR vm.account_name ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }

    query += ' ORDER BY vm.usage_count DESC, vm.vendor_name ASC';

    const { rows } = await pool.query(query, params);
    res.json({ mappings: rows, companyName: companyRows[0].company_name, realmId });
  } catch (err) {
    console.error('GET /api/bookkeeper/company/:companyId/mappings error:', err);
    res.status(500).json({ error: 'Failed to fetch mappings' });
  }
});

// ── GET /api/bookkeeper/runs/:runId/transactions ───────────
// All transactions processed in a specific run
router.get('/runs/:runId/transactions', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { runId } = req.params;

  try {
    // Auto-coded transactions are in the transactions table (bookkeeper_run_id)
    // Manually coded review items are in bookkeeper_uncoded (status=coded)
    // Query both and merge
    const { rows: autoRows } = await pool.query(`
      SELECT qb_id AS txn_qb_id, vendor_name, amount, date AS txn_date,
             description, original_account, coded_account, coded_by,
             'coded' AS status, ai_category AS ai_suggested_account, ai_confidence, ai_memo AS ai_reasoning
      FROM transactions
      WHERE bookkeeper_run_id = $1 AND firm_id = $2
        AND coded_account IS NOT NULL AND coded_account != ''
      ORDER BY amount DESC
    `, [runId, firmId]);

    const { rows: reviewRows } = await pool.query(`
      SELECT id, vendor_name, amount, txn_date, description, original_account,
             coded_account, coded_by, status, ai_suggested_account, ai_confidence, ai_reasoning
      FROM bookkeeper_uncoded
      WHERE run_id = $1 AND firm_id = $2 AND status = 'coded'
      ORDER BY amount DESC
    `, [runId, firmId]);

    // Merge, dedup by txn_qb_id preferring review rows (more detail)
    const seen = new Set();
    const merged = [];
    for (const r of [...reviewRows, ...autoRows]) {
      const key = r.txn_qb_id || r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
    merged.sort((a, b) => Math.abs(parseFloat(b.amount)) - Math.abs(parseFloat(a.amount)));

    res.json({ transactions: merged });
  } catch (err) {
    console.error('GET /api/bookkeeper/runs/:runId/transactions error:', err);
    res.status(500).json({ error: 'Failed to fetch run transactions' });
  }
});

// ── GET /api/bookkeeper/company/:companyId/runs ──────────────
// Bookkeeper run history for a specific company
router.get('/company/:companyId/runs', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { companyId } = req.params;
  const limit = parseInt(req.query.limit) || 20;

  try {
    const { rows: companyRows } = await pool.query(
      'SELECT realm_id, company_name FROM companies WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    if (!companyRows.length) return res.status(404).json({ error: 'Company not found' });
    const realmId = companyRows[0].realm_id;

    const { rows } = await pool.query(`
      SELECT br.*
      FROM bookkeeper_runs br
      WHERE br.firm_id = $1 AND br.realm_id = $2
      ORDER BY br.started_at DESC
      LIMIT $3
    `, [firmId, realmId, limit]);

    res.json({ runs: rows, companyName: companyRows[0].company_name });
  } catch (err) {
    console.error('GET /api/bookkeeper/company/:companyId/runs error:', err);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// ── GET /api/bookkeeper/history ────────────────────────────
// Coded transaction history for a company (last 30 days default)
router.get('/history', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId, days } = req.query;

  if (!realmId) return res.status(400).json({ error: 'realmId required' });

  const lookbackDays = parseInt(days) || 30;

  try {
    const { rows } = await pool.query(`
      SELECT t.qb_id, t.date, t.vendor_name, t.amount, t.description,
             t.original_account, t.coded_account, t.coded_by, t.coded_at,
             t.ai_category, t.ai_confidence, t.ai_memo, t.txn_type
      FROM transactions t
      WHERE t.realm_id = $1
        AND t.firm_id = $2
        AND t.status = 'categorized'
        AND t.coded_at >= NOW() - ($3 || ' days')::INTERVAL
      ORDER BY t.coded_at DESC
    `, [realmId, firmId, lookbackDays]);

    // Group by date for collapsible UI
    const byDate = {};
    for (const row of rows) {
      const dateKey = row.coded_at ? new Date(row.coded_at).toISOString().split('T')[0] : 'unknown';
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(row);
    }

    res.json({ transactions: rows, byDate, totalCount: rows.length });
  } catch (err) {
    console.error('GET /api/bookkeeper/history error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ── POST /api/bookkeeper/toggle ──────────────────────────────
// Enable or disable auto-bookkeeper for a company
router.post('/toggle', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { realmId, enabled } = req.body;

  if (!realmId || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'realmId and enabled (boolean) required' });
  }

  try {
    const { rowCount } = await pool.query(
      'UPDATE companies SET auto_bookkeeper_enabled = $1 WHERE realm_id = $2 AND firm_id = $3',
      [enabled, realmId, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Company not found' });
    res.json({ success: true, enabled });
  } catch (err) {
    console.error('POST /api/bookkeeper/toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle bookkeeper' });
  }
});

// ── POST /api/bookkeeper/company/:companyId/send-to-client ──────────────────
// Mark one or more uncoded transactions as sent to client for coding
router.post('/company/:companyId/send-to-client', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { companyId } = req.params;
  const { uncodedId, uncodedIds } = req.body; // single id or array

  try {
    // Verify company belongs to this firm
    const { rows: co } = await pool.query(
      'SELECT id FROM companies WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    if (!co.length) return res.status(404).json({ error: 'Company not found' });

    const ids = uncodedIds || (uncodedId ? [uncodedId] : []);
    if (!ids.length) return res.status(400).json({ error: 'No transaction ids provided' });

    // Only update rows that belong to this firm and are still pending
    const { rowCount } = await pool.query(
      `UPDATE bookkeeper_uncoded
       SET sent_to_client = TRUE, sent_to_client_at = NOW()
       WHERE id = ANY($1::int[]) AND firm_id = $2 AND sent_to_client = FALSE`,
      [ids, firmId]
    );

    // HIDDEN 2026-04-27 — Auto-Bookkeeper disabled. Immediate BKQ client email notification is off.
    // Uncomment the if-block below (and remove the `false &&`) to re-enable.
    // Send immediate email notification to portal users with access to this company
    // Deduped: only send if we haven't emailed this person today about BKQ for this company
    if (false && rowCount > 0) {
      try {
        const { sendBookkeepingQuestionsNotification, getFirmLogoUrl } = require('../services/email');
        const { rows: people } = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.email,
                  COALESCE(p.bkq_last_notified_at, '2000-01-01') AS last_notified
           FROM people p
           JOIN person_company_access pca ON pca.person_id = p.id
           WHERE pca.company_id = $1
             AND p.portal_enabled = TRUE
             AND p.email IS NOT NULL AND p.email <> ''`,
          [companyId]
        );
        const { rows: firmRows } = await pool.query(`SELECT display_name FROM firms WHERE id = $1`, [firmId]);
        const firmName = firmRows[0]?.display_name || 'Your Firm';
        const portalBase = process.env.PORTAL_URL || process.env.APP_URL || 'http://localhost:8080';
        const portalUrl = `${portalBase}/portal`;
        let logoUrl = null;
        try { logoUrl = await getFirmLogoUrl(firmId); } catch(e) { /* non-fatal */ }

        // Count total pending transactions for this person across all their companies
        for (const person of people) {
          // Skip if already notified today
          const lastNotified = new Date(person.last_notified);
          const today = new Date();
          if (lastNotified.toDateString() === today.toDateString()) continue;

          const { rows: countRows } = await pool.query(
            `SELECT COUNT(DISTINCT bu.txn_qb_id) AS cnt
             FROM bookkeeper_uncoded bu
             JOIN companies c ON c.realm_id = bu.realm_id
             JOIN person_company_access pca ON pca.company_id = c.id AND pca.person_id = $1
             WHERE bu.firm_id = $2 AND bu.sent_to_client = TRUE AND bu.coded_by_client = FALSE
               AND (bu.amount IS NOT NULL AND bu.amount != 0)`,
            [person.id, firmId]
          );
          const count = parseInt(countRows[0]?.cnt || 0);
          if (!count) continue;

          await sendBookkeepingQuestionsNotification({
            to: person.email,
            name: [person.first_name, person.last_name].filter(Boolean).join(' '),
            firmName,
            firmId,
            logoUrl,
            count,
            portalUrl,
          });

          // Record notification timestamp so we don't double-send today
          await pool.query(
            `UPDATE people SET bkq_last_notified_at = NOW() WHERE id = $1`,
            [person.id]
          ).catch(() => {}); // non-fatal if column doesn't exist yet
        }
      } catch(e) {
        console.error('[send-to-client] Email notification error:', e.message);
        // non-fatal — transaction was still marked sent
      }
    }

    res.json({ success: true, updated: rowCount });
  } catch (err) {
    console.error('POST /api/bookkeeper/company/:companyId/send-to-client error:', err);
    res.status(500).json({ error: 'Failed to send transactions to client' });
  }
});

// ── GET /api/bookkeeper/sent-to-client ──────────────────────
// Firm-wide: all sent-to-client pending transactions grouped by client (person)
router.get('/sent-to-client', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  try {
    // Dedup by realm_id+txn_qb_id, only pending (not yet coded by client)
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (bu.realm_id, bu.txn_qb_id)
        bu.id, bu.realm_id, bu.txn_qb_id, bu.txn_type, bu.txn_date,
        bu.vendor_name, bu.amount, bu.description, bu.original_account,
        bu.sent_to_client_at, bu.coded_by_client, bu.coded_by_client_account,
        bu.company_name, c.id AS company_id
      FROM bookkeeper_uncoded bu
      JOIN companies c ON c.realm_id = bu.realm_id AND c.firm_id = bu.firm_id
      WHERE bu.firm_id = $1
        AND bu.sent_to_client = TRUE
        AND bu.coded_by_client = FALSE
        AND (bu.amount IS NOT NULL AND bu.amount != 0)
      ORDER BY bu.realm_id, bu.txn_qb_id, bu.run_id DESC, bu.id DESC
    `, [firmId]);

    // For each company, find portal-enabled people with access — group by person
    const companyIds = [...new Set(rows.map(r => r.company_id))];
    const personMap = {}; // personId -> { person info, transactions[] }

    for (const companyId of companyIds) {
      const { rows: people } = await pool.query(
        `SELECT p.id, p.first_name, p.last_name, p.email
         FROM people p
         JOIN person_company_access pca ON pca.person_id = p.id
         WHERE pca.company_id = $1 AND p.portal_enabled = TRUE`,
        [companyId]
      );
      const companyTxns = rows.filter(r => r.company_id === companyId);
      for (const person of people) {
        if (!personMap[person.id]) {
          personMap[person.id] = {
            personId: person.id,
            name: [person.first_name, person.last_name].filter(Boolean).join(' '),
            email: person.email,
            transactions: [],
          };
        }
        for (const txn of companyTxns) {
          if (!personMap[person.id].transactions.find(t => t.id === txn.id)) {
            personMap[person.id].transactions.push(txn);
          }
        }
      }
    }

    // Sort people alpha by name
    const clients = Object.values(personMap).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ clients });
  } catch (err) {
    console.error('GET /api/bookkeeper/sent-to-client error:', err);
    res.status(500).json({ error: 'Failed to fetch sent-to-client transactions' });
  }
});

// ── GET /api/bookkeeper/company/:companyId/sent-to-client ───
// Per-company sent-to-client list — used by CRM company page
router.get('/company/:companyId/sent-to-client', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { companyId } = req.params;

  try {
    const { rows: co } = await pool.query(
      'SELECT realm_id, company_name FROM companies WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    if (!co.length) return res.status(404).json({ error: 'Company not found' });
    const { realm_id: realmId } = co[0];

    // Dedup by txn_qb_id, most recent run, only sent-to-client rows
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (txn_qb_id) *
      FROM bookkeeper_uncoded
      WHERE firm_id = $1 AND realm_id = $2 AND sent_to_client = TRUE
        AND (amount IS NOT NULL AND amount != 0)
      ORDER BY txn_qb_id, run_id DESC, id DESC
    `, [firmId, realmId]);

    rows.sort((a, b) => {
      const da = new Date(a.sent_to_client_at || 0);
      const db = new Date(b.sent_to_client_at || 0);
      return db - da;
    });

    res.json({ transactions: rows });
  } catch (err) {
    console.error('GET /api/bookkeeper/company/:companyId/sent-to-client error:', err);
    res.status(500).json({ error: 'Failed to fetch sent-to-client transactions' });
  }
});

// ── POST /api/bookkeeper/test-bkq-email ─────────────────────────────────
// Dev/test: send a sample bookkeeping questions reminder to the requesting user
router.post('/test-bkq-email', requireFirm, async (req, res) => {
  try {
    const firmId = req.firm.id;
    const userId = req.firm.userId;
    const { sendBookkeepingQuestionsNotification, getFirmLogoUrl } = require('../services/email');

    const { rows: userRows } = await pool.query(
      `SELECT first_name, last_name, email FROM firm_users WHERE id = $1 AND firm_id = $2`,
      [userId, firmId]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRows[0];

    const { rows: firmRows } = await pool.query(`SELECT display_name FROM firms WHERE id = $1`, [firmId]);
    const firmName = firmRows[0]?.display_name || 'Your Firm';

    let logoUrl = null;
    try { logoUrl = await getFirmLogoUrl(firmId); } catch(e) { /* non-fatal */ }

    const portalBase = process.env.PORTAL_URL || process.env.APP_URL || 'http://localhost:8080';
    await sendBookkeepingQuestionsNotification({
      to: user.email,
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      firmName,
      firmId,
      logoUrl,
      count: 3,
      portalUrl: `${portalBase}/portal`,
    });

    res.json({ success: true, sentTo: user.email });
  } catch (err) {
    console.error('POST /api/bookkeeper/test-bkq-email error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
