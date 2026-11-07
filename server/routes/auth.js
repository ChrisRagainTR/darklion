const { Router } = require('express');
const { pool } = require('../db');
const { requireFirm } = require('../middleware/requireFirm');
const { requirePortal } = require('../middleware/requirePortal');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const router = Router();

// QuickBooks OAuth state is issued and signed by the server, tied to one firm and
// (optionally) one company, and expires quickly. The callback trusts nothing else.
const QBO_STATE_TTL = '15m';
function signQboState(req, firmId, companyId) {
  return jwt.sign({
    typ: 'qbo_state', firmId, companyId: companyId || null,
    returnOrigin: `${req.protocol}://${req.get('host')}`,
    nonce: crypto.randomBytes(8).toString('hex'),
  }, process.env.JWT_SECRET, { expiresIn: QBO_STATE_TTL });
}
function verifyQboState(state) {
  try {
    const payload = jwt.verify(String(state || ''), process.env.JWT_SECRET);
    return payload.typ === 'qbo_state' && Number.isSafeInteger(payload.firmId) && payload.firmId > 0 ? payload : null;
  } catch (_) { return null; }
}

// Staff: connect any company in their firm, or start a new connection.
router.post('/qbo-state', requireFirm, async (req, res) => {
  try {
    const companyId = req.body?.company_id ? parseInt(req.body.company_id, 10) : null;
    if (companyId) {
      const { rows } = await pool.query('SELECT 1 FROM companies WHERE id = $1 AND firm_id = $2', [companyId, req.firm.id]);
      if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    }
    res.json({ state: signQboState(req, req.firm.id, companyId) });
  } catch (err) {
    console.error('QBO state error:', err);
    res.status(500).json({ error: 'Could not start the connection' });
  }
});

// Portal clients: connect a company they have access to.
router.post('/qbo-state/portal', requirePortal, async (req, res) => {
  try {
    const companyId = parseInt(req.body?.company_id, 10);
    if (!companyId) return res.status(400).json({ error: 'Company is required' });
    const { rows } = await pool.query(
      `SELECT 1 FROM person_company_access pca JOIN companies c ON c.id = pca.company_id
       WHERE pca.person_id = $1 AND pca.company_id = $2 AND c.firm_id = $3`,
      [req.portal.personId, companyId, req.portal.firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json({ state: signQboState(req, req.portal.firmId, companyId) });
  } catch (err) {
    console.error('QBO portal state error:', err);
    res.status(500).json({ error: 'Could not start the connection' });
  }
});

// Exchange authorization code for tokens
router.get('/callback', async (req, res) => {
  const { code, realmId, state } = req.query;

  if (!code || !realmId) {
    return res.status(400).json({ error: 'Missing code or realmId' });
  }
  const verifiedState = verifyQboState(state);
  if (!verifiedState) {
    return res.status(400).json({ error: 'This connection link has expired. Please start the QuickBooks connection again.' });
  }

  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const redirectUri = process.env.QB_REDIRECT_URI;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('Token exchange failed:', errBody);
      return res.status(502).json({ error: 'Token exchange failed' });
    }

    const tokens = await tokenRes.json();
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    // Fetch company info
    let companyName = '';
    try {
      const companyRes = await fetch(
        `https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`,
        { headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' } }
      );
      if (companyRes.ok) {
        const companyData = await companyRes.json();
        companyName = companyData.CompanyInfo?.CompanyName || '';
      }
    } catch (e) {
      // Non-fatal — we just won't have the name
    }

    // Firm, company and return origin come only from the signed state.
    const firmId = verifiedState.firmId;
    const darklionCompanyId = verifiedState.companyId || null;
    const returnOrigin = verifiedState.returnOrigin || null;

    // If we have a specific DarkLion company_id, update that record with the realm/tokens
    if (darklionCompanyId) {
      // Get current realm_id so we can clean up FK-referencing rows if it's changing
      const { rows: curRows } = await pool.query('SELECT realm_id FROM companies WHERE id = $1 AND firm_id = $2', [darklionCompanyId, firmId]);
      if (!curRows.length) return res.status(404).json({ error: 'Company not found' });
      const { rows: otherFirm } = await pool.query('SELECT 1 FROM companies WHERE realm_id = $1 AND firm_id <> $2', [realmId, firmId]);
      if (otherFirm.length) return res.status(409).json({ error: 'This QuickBooks company is already connected elsewhere.' });
      const oldRealmId = curRows[0]?.realm_id;

      if (oldRealmId && oldRealmId !== realmId) {
        // Old realm_id is changing — delete orphaned child rows that FK-reference it
        // These are all fake/empty if the old realm was a placeholder
        await pool.query('DELETE FROM scan_results WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM close_packages WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM category_rules WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM jobs WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM statement_schedules WHERE realm_id = $1', [oldRealmId]).catch(() => {});
      }

      await pool.query(`
        UPDATE companies SET
          realm_id = $1, company_name = COALESCE(NULLIF($2,''), company_name),
          access_token = $3, refresh_token = $4, token_expires_at = $5,
          connected_at = NOW()
        WHERE id = $6 AND firm_id = $7
      `, [realmId, companyName, tokens.access_token, tokens.refresh_token, expiresAt, darklionCompanyId, firmId]);
    } else {
      // No specific company — upsert by realm_id (new connection). Never take over
      // a realm that belongs to a different firm.
      const { rowCount } = await pool.query(`
        INSERT INTO companies (realm_id, company_name, access_token, refresh_token, token_expires_at, firm_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(realm_id) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          token_expires_at = EXCLUDED.token_expires_at,
          connected_at = NOW()
        WHERE companies.firm_id = EXCLUDED.firm_id
      `, [realmId, companyName, tokens.access_token, tokens.refresh_token, expiresAt, firmId]);
      if (!rowCount) return res.status(409).json({ error: 'This QuickBooks company is already connected elsewhere.' });
    }

    // Audit log
    try {
      const { auditLog } = require('../services/audit');
      await auditLog(firmId, 'company_connect', `Connected: ${companyName || realmId} (realm: ${realmId})`, req.ip);
    } catch (e) { /* non-fatal */ }

    // Sync revenue in background on first connect
    try {
      const { syncCompanyRevenue } = require('../services/revenueSync');
      syncCompanyRevenue(realmId).catch(() => {});
    } catch (e) { /* non-fatal */ }

    // Backfill searchable QBO transaction history in background on connect/reconnect.
    // Non-blocking: OAuth callback should succeed even if QBO history import has a partial failure.
    runInitialTransactionBackfill(realmId).catch(e => console.error('Initial transaction backfill error:', e.message));

    const appBase = returnOrigin || (process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : '');
    const isXHR = req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers['accept'] || '').includes('application/json') || req.headers['authorization'];

    if (isXHR) {
      // Called via fetch from callback.html — return JSON so it can show success UI
      return res.json({ ok: true, company: companyName || realmId, company_id: darklionCompanyId });
    }

    // Run initial scans in background (non-blocking)
    runInitialScans(realmId).catch(e => console.error('Initial scan error:', e));

    // Direct browser redirect from Intuit — redirect back to the origin they started from
    if (darklionCompanyId) {
      return res.redirect(`${appBase}/crm/company/${darklionCompanyId}?connected=1`);
    }
    return res.redirect(`${appBase}/crm?qbo=connected`);
  } catch (err) {
    console.error('OAuth callback error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Run scans immediately after a company connects
async function runInitialScans(realmId) {
  const { scanUncategorized } = require('../services/scanner');
  const { generateDefaultClosePackage, defaultClosePackagePeriod } = require('../services/reports');
  const { scanVariance } = require('../services/variance');
  const { scanLiabilities } = require('../services/liability');

  console.log(`Running initial scans for ${realmId}...`);

  try {
    await scanUncategorized(realmId);
    console.log(`Uncategorized scan complete for ${realmId}`);
  } catch (e) {
    console.error(`Initial uncategorized scan failed for ${realmId}:`, e.message);
  }

  try {
    const period = defaultClosePackagePeriod();
    await generateDefaultClosePackage(realmId);
    console.log(`Close package generated for ${realmId} (${period})`);
  } catch (e) {
    console.error(`Initial close package failed for ${realmId}:`, e.message);
  }

  try {
    await scanVariance(realmId);
    console.log(`Variance analysis complete for ${realmId}`);
  } catch (e) {
    console.error(`Initial variance scan failed for ${realmId}:`, e.message);
  }

  try {
    await scanLiabilities(realmId);
    console.log(`Liability check complete for ${realmId}`);
  } catch (e) {
    console.error(`Initial liability check failed for ${realmId}:`, e.message);
  }
}

async function runInitialTransactionBackfill(realmId) {
  const { backfillCompanyTransactions } = require('../services/transactionBackfill');

  const { rows } = await pool.query(
    `SELECT firm_id, id, company_name FROM companies WHERE realm_id = $1 LIMIT 1`,
    [realmId]
  );
  const company = rows[0];
  if (!company?.firm_id || !company?.id) {
    console.warn(`Initial transaction backfill skipped for ${realmId}: company/firm not found`);
    return;
  }

  const result = await backfillCompanyTransactions({
    firmId: company.firm_id,
    companyId: company.id,
    months: 24,
  });
  console.log(`Initial transaction backfill complete for ${company.company_name || realmId}: fetched=${result.fetched}, inserted=${result.inserted}, updated=${result.updated}`);
}


module.exports = router;
