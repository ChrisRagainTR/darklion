const { Router } = require('express');
const { pool } = require('../db');
const { scanUncategorized, getLatestScan } = require('../services/scanner');
const { generateClosePackage, defaultClosePackagePeriod } = require('../services/reports');
const { scanVariance } = require('../services/variance');
const { scanLiabilities } = require('../services/liability');
const { auditLog } = require('../services/audit');
const { getChartOfAccounts, qbFetch, writeBackTransaction } = require('../services/quickbooks');
const {
  getStatus: getLedgerHqStatus,
  getCompanyLink: getLedgerHqCompanyLink,
  listLedgerHqClosePackages,
} = require('../services/ledgerhq');
const { generateClosePackageForProvider } = require('../services/closePackageProvider');
const { generateTaxFinancialsPdf } = require('../services/taxFinancialsPdf');
const { uploadFile, buildKey } = require('../services/s3');
const { fireTrigger } = require('../services/pipelineTriggers');
const { searchFirmCrm } = require('../services/crmSearch');

const router = Router();
router.use((req, res, next) => {
  if (!Number.isSafeInteger(Number(req.firm?.id)) || Number(req.firm.id) < 1) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
});
router.use('/companies', require('./bookkeeping-source'));

// Helper: verify realm belongs to this firm AND user has access (via firm_user_companies)
async function assertRealmOwner(firmId, realmId, res, userId) {
  // Check firm owns the company
  const { rows } = await pool.query(
    'SELECT realm_id FROM companies WHERE realm_id = $1 AND firm_id = $2',
    [realmId, firmId]
  );
  if (rows.length === 0) {
    res.status(403).json({ error: 'Access denied to this company' });
    return false;
  }

  // Check per-user company restriction (if userId present)
  if (userId) {
    const { rows: accessRows } = await pool.query(
      'SELECT id FROM firm_user_companies WHERE firm_user_id = $1',
      [userId]
    );
    // If user has specific company restrictions, check if this realm is allowed
    if (accessRows.length > 0) {
      const { rows: allowed } = await pool.query(
        'SELECT id FROM firm_user_companies WHERE firm_user_id = $1 AND realm_id = $2',
        [userId, realmId]
      );
      if (allowed.length === 0) {
        res.status(403).json({ error: 'Access denied to this company' });
        return false;
      }
    }
    // If no rows → unrestricted access to all firm companies
  }

  return true;
}

// Helper: get allowed realm IDs for a user (empty array = all)
async function getUserAllowedRealms(userId) {
  if (!userId) return null; // no restriction
  const { rows } = await pool.query(
    'SELECT realm_id FROM firm_user_companies WHERE firm_user_id = $1',
    [userId]
  );
  return rows.length > 0 ? rows.map(r => r.realm_id) : null; // null = unrestricted
}

// --- Dashboard data ---

// --- Staff mobile CRM/contact search ---
router.get('/mobile/staff-contacts', async (req, res) => {
  const firmId = req.firm.id;
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ contacts: [] });

  const like = `%${q}%`;
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.first_name,
        p.last_name,
        NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS name,
        p.email,
        p.phone,
        p.filing_status,
        p.portal_enabled,
        p.spouse_name,
        p.spouse_email,
        p.relationship_id,
        r.name AS relationship_name,
        r.service_tier,
        r.billing_status,
        COUNT(DISTINCT pca.company_id) AS company_count
      FROM people p
      LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = p.firm_id
      LEFT JOIN person_company_access pca ON pca.person_id = p.id
      WHERE p.firm_id = $1
        AND (
          p.first_name ILIKE $2
          OR p.last_name ILIKE $2
          OR (p.first_name || ' ' || p.last_name) ILIKE $2
          OR p.email ILIKE $2
          OR p.phone ILIKE $2
          OR p.spouse_name ILIKE $2
          OR r.name ILIKE $2
        )
      GROUP BY p.id, r.id
      ORDER BY p.last_name ASC, p.first_name ASC
      LIMIT 25
    `, [firmId, like]);
    res.json({ contacts: rows });
  } catch (err) {
    console.error('GET /api/mobile/staff-contacts error:', err);
    res.status(500).json({ error: 'Failed to search contacts' });
  }
});

router.get('/mobile/staff-contacts/:id', async (req, res) => {
  const firmId = req.firm.id;
  const personId = parseInt(req.params.id, 10);
  if (!personId) return res.status(400).json({ error: 'Invalid contact id' });

  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.first_name,
        p.last_name,
        NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS name,
        p.email,
        p.phone,
        p.filing_status,
        p.portal_enabled,
        p.spouse_name,
        p.spouse_email,
        p.spouse_portal_enabled,
        p.address_line1,
        p.address_line2,
        p.city,
        p.state,
        p.zip,
        p.notes,
        p.relationship_id,
        r.name AS relationship_name,
        r.service_tier,
        r.billing_status,
        r.notes AS relationship_notes
      FROM people p
      LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = p.firm_id
      WHERE p.id = $1 AND p.firm_id = $2
      LIMIT 1
    `, [personId, firmId]);
    if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });

    const { rows: companies } = await pool.query(`
      SELECT c.id, c.company_name, c.entity_type, c.status, c.billing_method,
             c.bookkeeping_service, pca.access_level, pca.ownership_pct
      FROM person_company_access pca
      JOIN companies c ON c.id = pca.company_id AND c.firm_id = $2
      WHERE pca.person_id = $1 AND c.archived_at IS NULL
      ORDER BY c.company_name ASC
    `, [personId, firmId]);

    const relationshipId = rows[0].relationship_id;
    const companyIds = companies.map(company => company.id);
    const workflowParams = [firmId, personId];
    const workflowWhere = [
      "(pj.entity_type = 'person' AND pj.entity_id = $2)"
    ];

    if (relationshipId) {
      workflowParams.push(relationshipId);
      workflowWhere.push(`(pj.entity_type = 'relationship' AND pj.entity_id = $${workflowParams.length})`);
    }

    if (companyIds.length) {
      workflowParams.push(companyIds);
      workflowWhere.push(`(pj.entity_type = 'company' AND pj.entity_id = ANY($${workflowParams.length}::int[]))`);
    }

    const { rows: workflow } = await pool.query(`
      SELECT
        pj.id,
        pj.entity_type,
        pj.entity_id,
        pj.priority,
        pj.due_date,
        pj.job_status,
        pt.name AS pipeline_name,
        pi.tax_year,
        ps.name AS stage_name,
        ps.position AS stage_position,
        COALESCE(
          NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), ''),
          c.company_name,
          r.name,
          'Client'
        ) AS entity_name
      FROM pipeline_jobs pj
      JOIN pipeline_instances pi ON pi.id = pj.instance_id
      JOIN pipeline_templates pt ON pt.id = pi.template_id
      LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
      LEFT JOIN people p ON p.id = pj.entity_id AND pj.entity_type = 'person' AND p.firm_id = pi.firm_id
      LEFT JOIN companies c ON c.id = pj.entity_id AND pj.entity_type = 'company' AND c.firm_id = pi.firm_id
      LEFT JOIN relationships r ON r.id = pj.entity_id AND pj.entity_type = 'relationship' AND r.firm_id = pi.firm_id
      WHERE pi.firm_id = $1
        AND COALESCE(pj.job_status, 'active') NOT IN ('complete', 'completed', 'archived', 'done')
        AND (${workflowWhere.join(' OR ')})
      ORDER BY ps.position ASC NULLS LAST, pj.updated_at DESC
      LIMIT 25
    `, workflowParams);

    res.json({ contact: rows[0], companies, workflow });
  } catch (err) {
    console.error('GET /api/mobile/staff-contacts/:id error:', err);
    res.status(500).json({ error: 'Failed to load contact' });
  }
});

// --- Unified search ---
router.get('/search', async (req, res) => {
  const firmId = req.firm.id;
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ relationships: [], companies: [], people: [] });

  try {
    res.json(await searchFirmCrm({ firmId, query: q }));
  } catch (err) {
    console.error('GET /api/search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});


// Validate browser-cached recent CRM records before showing them in global search.
// Recents live in localStorage, so they can outlive deleted/merged records.
router.post('/search/validate-recents', async (req, res) => {
  const firmId = req.firm.id;
  const input = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = input
    .map(item => ({
      _type: String(item?._type || '').toLowerCase(),
      id: Number.parseInt(item?.id, 10),
      _label: item?._label || item?.name || 'Untitled',
      _sub: item?._sub || '',
    }))
    .filter(item => ['relationship', 'company', 'person'].includes(item._type) && Number.isInteger(item.id) && item.id > 0)
    .slice(0, 10);

  if (!items.length) return res.json({ items: [] });

  const idsByType = items.reduce((acc, item) => {
    acc[item._type].push(item.id);
    return acc;
  }, { relationship: [], company: [], person: [] });

  try {
    const [relRes, compRes, peopleRes] = await Promise.all([
      idsByType.relationship.length
        ? pool.query('SELECT id FROM relationships WHERE firm_id = $1 AND id = ANY($2::int[])', [firmId, idsByType.relationship])
        : Promise.resolve({ rows: [] }),
      idsByType.company.length
        ? pool.query('SELECT id FROM companies WHERE firm_id = $1 AND archived_at IS NULL AND id = ANY($2::int[])', [firmId, idsByType.company])
        : Promise.resolve({ rows: [] }),
      idsByType.person.length
        ? pool.query('SELECT id FROM people WHERE firm_id = $1 AND id = ANY($2::int[])', [firmId, idsByType.person])
        : Promise.resolve({ rows: [] }),
    ]);

    const valid = new Set([
      ...relRes.rows.map(r => `relationship:${r.id}`),
      ...compRes.rows.map(r => `company:${r.id}`),
      ...peopleRes.rows.map(r => `person:${r.id}`),
    ]);

    res.json({ items: items.filter(item => valid.has(`${item._type}:${item.id}`)).slice(0, 5) });
  } catch (err) {
    console.error('POST /api/search/validate-recents error:', err);
    res.status(500).json({ error: 'Recent validation failed' });
  }
});

// List connected companies scoped to this firm (filtered by user access)
router.get('/companies', async (req, res) => {
  const firmId = req.firm?.id;
  const userId = req.firm?.userId || null;
  let query, params;

  if (firmId) {
    query = 'SELECT realm_id, company_name, connected_at, last_sync_at, token_expires_at, refresh_token FROM companies WHERE firm_id = $1 AND archived_at IS NULL ORDER BY company_name ASC';
    params = [firmId];
  } else {
    query = 'SELECT realm_id, company_name, connected_at, last_sync_at, token_expires_at, refresh_token FROM companies ORDER BY company_name ASC';
    params = [];
  }

  let { rows } = await pool.query(query, params);

  // Filter by per-user company access if applicable
  if (userId && firmId) {
    const allowedRealms = await getUserAllowedRealms(userId);
    if (allowedRealms !== null) {
      rows = rows.filter(r => allowedRealms.includes(r.realm_id));
    }
  }
  const now = Date.now();
  const { refreshTokens } = require('../services/qboTokens');

  const enriched = [];
  for (const c of rows) {
    let tokenStatus = 'connected';
    const expired = c.token_expires_at && Number(c.token_expires_at) < now;

    if (expired && c.refresh_token && !req.firm?.supportSession) {
      try {
        await refreshTokens(c.realm_id);
        tokenStatus = 'connected';
      } catch (e) {
        tokenStatus = 'disconnected';
      }
    } else if (!c.refresh_token) {
      tokenStatus = 'disconnected';
    }

    enriched.push({
      realm_id: c.realm_id,
      company_name: c.company_name,
      connected_at: c.connected_at,
      last_sync_at: c.last_sync_at,
      token_status: tokenStatus,
    });
  }
  res.json(enriched);
});

// POST /api/companies — create a new company (firm-scoped)
router.post('/companies', async (req, res) => {
  const firmId = req.firm?.id;
  const { company_name, relationship_id, entity_type, bookkeeping_service, billing_method, tax_year_end, address_line1 = '', address_line2 = '', city = '', state = '', zip = '' } = req.body;
  if (!company_name) return res.status(400).json({ error: 'company_name is required' });
  if (!relationship_id) return res.status(400).json({ error: 'relationship_id is required' });
  try {
    const { rows: rel } = await pool.query('SELECT id FROM relationships WHERE id = $1 AND firm_id = $2', [relationship_id, firmId]);
    if (!rel.length) return res.status(404).json({ error: 'Relationship not found' });
    // Use a unique placeholder for realm_id since the column has a UNIQUE constraint
    const uniqueRealmPlaceholder = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query(
      `INSERT INTO companies (firm_id, company_name, relationship_id, entity_type, bookkeeping_service, billing_method, tax_year_end, realm_id, access_token, refresh_token, token_expires_at, address_line1, address_line2, city, state, zip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', '', 0, $9, $10, $11, $12, $13) RETURNING id, company_name, entity_type, bookkeeping_service, relationship_id, firm_id, address_line1, address_line2, city, state, zip`,
      [firmId, company_name, relationship_id, entity_type || 'other', bookkeeping_service || 'none', billing_method || null, tax_year_end || '12/31', uniqueRealmPlaceholder, address_line1, address_line2, city, state, zip]
    );
    const newCompany = rows[0];

    // Auto-grant portal access to all people already in this relationship
    await pool.query(`
      INSERT INTO person_company_access (person_id, company_id, access_level)
      SELECT p.id, $1, 'full'
      FROM people p
      WHERE p.relationship_id = $2 AND p.firm_id = $3
      ON CONFLICT (person_id, company_id) DO NOTHING
    `, [newCompany.id, relationship_id, firmId]).catch(e =>
      console.warn('[companies] auto-grant access non-fatal:', e.message)
    );

    res.status(201).json(newCompany);
  } catch (err) {
    console.error('POST /companies error:', err);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

// GET /api/companies/archived — list archived companies (must be before /:id wildcard)
router.get('/companies/archived', async (req, res) => {
  const firmId = req.firm?.id;
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.company_name, c.entity_type, c.archived_at,
              r.name AS relationship_name
       FROM companies c
       LEFT JOIN relationships r ON r.id = c.relationship_id
       WHERE c.firm_id = $1 AND c.archived_at IS NOT NULL
       ORDER BY c.archived_at DESC`,
      [firmId]
    );
    res.json({ companies: rows });
  } catch (err) {
    console.error('GET /companies/archived error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/companies/:id — get single company by integer id (firm-scoped)
router.get('/companies/:id([0-9]+)', async (req, res) => {
  const firmId = req.firm?.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, company_name, entity_type, ein_encrypted, tax_year_end, stanford_tax_url,
              status, relationship_id, realm_id, connected_at, last_sync_at, notes, firm_id,
              bookkeeper_id, bookkeeping_service, bookkeeping_provider, billing_method,
              address_line1, address_line2, city, state, zip,
              (realm_id IS NOT NULL AND realm_id != '' AND access_token IS NOT NULL AND access_token != '') AS qbo_connected
       FROM companies
       WHERE id = $1 AND firm_id = $2`,
      [id, firmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const co = { ...rows[0] };
    co.has_ein = !!(co.ein_encrypted && co.ein_encrypted !== '');
    delete co.ein_encrypted;
    try {
      const ledgerStatus = await getLedgerHqStatus(firmId);
      const ledgerLink = ledgerStatus.connected ? await getLedgerHqCompanyLink(co.id, firmId) : null;
      co.ledgerhq_connected = ledgerStatus.connected;
      co.ledgerhq_link = ledgerLink ? {
        provider_company_id: ledgerLink.provider_company_id,
        provider_company_name: ledgerLink.provider_company_name,
      } : null;
    } catch (_) {
      co.ledgerhq_connected = false;
      co.ledgerhq_link = null;
    }

    // Include relationship info
    if (co.relationship_id) {
      const { rows: relRows } = await pool.query(
        'SELECT id, name FROM relationships WHERE id = $1 AND firm_id = $2',
        [co.relationship_id, firmId]
      );
      co.relationship = relRows[0] || null;
    } else {
      co.relationship = null;
    }

    // Include people with access
    const { rows: peopleRows } = await pool.query(
      `SELECT pca.person_id, pca.access_level, pca.ownership_pct,
              p.first_name, p.last_name, p.email, p.portal_enabled,
              p.filing_status, p.spouse_name, p.spouse_email
       FROM person_company_access pca
       JOIN people p ON p.id = pca.person_id
       WHERE pca.company_id = $1 AND p.firm_id = $2
       ORDER BY p.last_name ASC, p.first_name ASC`,
      [id, firmId]
    );
    co.people = peopleRows;

    // Fetch bookkeeper name if set
    try {
      if (co.bookkeeper_id) {
        const { rows: bkRows } = await pool.query(
          "SELECT id, COALESCE(NULLIF(display_name, ''), name) AS name FROM firm_users WHERE id = $1 AND firm_id = $2",
          [co.bookkeeper_id, firmId]
        );
        co.bookkeeper = bkRows[0] || null;
      } else {
        co.bookkeeper = null;
      }
    } catch(_) { co.bookkeeper = null; }

    res.json(co);
  } catch (err) {
    console.error('GET /api/companies/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

// PUT /api/companies/:id — update company fields (firm-scoped)
router.put('/companies/:id([0-9]+)', async (req, res) => {
  const firmId = req.firm?.id;
  const { id } = req.params;
  const { company_name, entity_type, tax_year_end, stanford_tax_url, status, relationship_id, notes, bookkeeper_id, bookkeeping_service, billing_method, address_line1, address_line2, city, state, zip } = req.body;
  try {
    const { rows: existing } = await pool.query(
      'SELECT id, bookkeeper_id FROM companies WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Company not found' });

    if (relationship_id) {
      const related = await pool.query('SELECT id FROM relationships WHERE id = $1 AND firm_id = $2', [relationship_id, firmId]);
      if (!related.rowCount) return res.status(404).json({ error: 'Relationship not found' });
    }
    if (bookkeeper_id) {
      // Historical same-firm assignments can survive unrelated edits. Selecting
      // a different bookkeeper still requires an active, accepted staff member.
      const staff = await pool.query(`SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2
        AND ((archived_at IS NULL AND accepted_at IS NOT NULL) OR id = $3)`,
      [bookkeeper_id, firmId, existing[0].bookkeeper_id]);
      if (!staff.rowCount) return res.status(404).json({ error: 'Staff member not found' });
    }

    const { rows } = await pool.query(
      `UPDATE companies SET
         company_name = COALESCE($1, company_name),
         entity_type = COALESCE($2, entity_type),
         tax_year_end = COALESCE($3, tax_year_end),
         stanford_tax_url = COALESCE($4, stanford_tax_url),
         status = COALESCE($5, status),
         relationship_id = COALESCE($6, relationship_id),
         notes = COALESCE($7, notes),
         bookkeeper_id = CASE WHEN $18::BOOLEAN THEN $10 ELSE bookkeeper_id END,
         bookkeeping_service = CASE WHEN $19::BOOLEAN THEN $11 ELSE bookkeeping_service END,
         billing_method = COALESCE($12, billing_method),
         address_line1 = CASE WHEN $13::TEXT IS NOT NULL THEN $13 ELSE address_line1 END,
         address_line2 = CASE WHEN $14::TEXT IS NOT NULL THEN $14 ELSE address_line2 END,
         city = CASE WHEN $15::TEXT IS NOT NULL THEN $15 ELSE city END,
         state = CASE WHEN $16::TEXT IS NOT NULL THEN $16 ELSE state END,
         zip = CASE WHEN $17::TEXT IS NOT NULL THEN $17 ELSE zip END
       WHERE id = $8 AND firm_id = $9
       RETURNING id, company_name, entity_type, tax_year_end, stanford_tax_url, status, relationship_id, realm_id, notes, bookkeeper_id, bookkeeping_service, billing_method, address_line1, address_line2, city, state, zip`,
      [
        company_name || null,
        entity_type || null,
        tax_year_end || null,
        stanford_tax_url !== undefined ? stanford_tax_url : null,
        status || null,
        relationship_id || null,
        notes !== undefined ? notes : null,
        id,
        firmId,
        bookkeeper_id !== undefined ? (bookkeeper_id || null) : undefined,
        bookkeeping_service !== undefined ? (bookkeeping_service || null) : undefined,
        billing_method !== undefined ? (billing_method || null) : null,
        address_line1 !== undefined ? (address_line1 || '') : null,
        address_line2 !== undefined ? (address_line2 || '') : null,
        city !== undefined ? (city || '') : null,
        state !== undefined ? (state || '') : null,
        zip !== undefined ? (zip || '') : null,
        bookkeeper_id !== undefined,
        bookkeeping_service !== undefined,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/companies/:id error:', err);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// POST /api/companies/:id/move-relationship — move a company to another relationship and optionally sync portal access
router.post('/companies/:id([0-9]+)/move-relationship', async (req, res) => {
  const firmId = req.firm?.id;
  const companyId = parseInt(req.params.id, 10);
  const relationshipId = parseInt(req.body?.relationship_id, 10);
  const syncCompanyAccess = req.body?.sync_company_access !== false;

  if (!companyId) return res.status(400).json({ error: 'Invalid company id' });
  if (!relationshipId) return res.status(400).json({ error: 'relationship_id is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: companyRows } = await client.query(
      'SELECT id, relationship_id, company_name FROM companies WHERE id = $1 AND firm_id = $2 FOR UPDATE',
      [companyId, firmId]
    );
    if (companyRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Company not found' });
    }

    const { rows: relRows } = await client.query(
      'SELECT id, name FROM relationships WHERE id = $1 AND firm_id = $2',
      [relationshipId, firmId]
    );
    if (relRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Relationship not found' });
    }

    const previousRelationshipId = companyRows[0].relationship_id;
    if (previousRelationshipId === relationshipId) {
      await client.query('COMMIT');
      return res.json({
        success: true,
        moved: false,
        relationship_id: relationshipId,
        relationship_name: relRows[0].name,
      });
    }

    await client.query(
      'UPDATE companies SET relationship_id = $1 WHERE id = $2 AND firm_id = $3',
      [relationshipId, companyId, firmId]
    );

    if (syncCompanyAccess) {
      await client.query(`
        INSERT INTO person_company_access (person_id, company_id, access_level)
        SELECT p.id, $1, 'full'
        FROM people p
        WHERE p.relationship_id = $2 AND p.firm_id = $3
        ON CONFLICT (person_id, company_id) DO NOTHING
      `, [companyId, relationshipId, firmId]);

      if (previousRelationshipId) {
        await client.query(`
          DELETE FROM person_company_access pca
          USING people p
          WHERE pca.person_id = p.id
            AND pca.company_id = $1
            AND p.firm_id = $2
            AND p.relationship_id = $3
        `, [companyId, firmId, previousRelationshipId]);
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      moved: true,
      previous_relationship_id: previousRelationshipId,
      relationship_id: relationshipId,
      relationship_name: relRows[0].name,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/companies/:id/move-relationship error:', err);
    res.status(500).json({ error: 'Failed to move company' });
  } finally {
    client.release();
  }
});

// DELETE /api/companies/id/:id — delete company by integer ID (firm-scoped)
router.delete('/companies/id/:id([0-9]+)', async (req, res) => {
  const firmId = req.firm?.id;
  const companyId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      'SELECT company_name, realm_id FROM companies WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    const { company_name, realm_id } = rows[0];

    await pool.query('DELETE FROM person_company_access WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM documents WHERE owner_type = $1 AND owner_id = $2', ['company', companyId]);
    await pool.query('DELETE FROM pipeline_jobs WHERE entity_type = $1 AND entity_id = $2', ['company', companyId]);
    await pool.query('DELETE FROM thread_companies WHERE company_id = $1', [companyId]);
    if (realm_id && !realm_id.startsWith('import-')) {
      await pool.query('DELETE FROM scan_results WHERE realm_id = $1', [realm_id]);
      await pool.query('DELETE FROM close_packages WHERE realm_id = $1', [realm_id]);
      await pool.query('DELETE FROM statement_schedules WHERE realm_id = $1', [realm_id]);
      await pool.query('DELETE FROM jobs WHERE realm_id = $1', [realm_id]).catch(()=>{});
      await pool.query('DELETE FROM transactions WHERE realm_id = $1', [realm_id]).catch(()=>{});
    }
    await pool.query('DELETE FROM companies WHERE id = $1 AND firm_id = $2', [companyId, firmId]);
    await auditLog(firmId, 'company_delete', `Deleted: ${company_name}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /companies/id/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies/id/:id/archive — archive a company (soft delete)
router.post('/companies/id/:id([0-9]+)/archive', async (req, res) => {
  const firmId = req.firm?.id;
  const companyId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      'SELECT company_name FROM companies WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    await pool.query(
      'UPDATE companies SET archived_at = NOW() WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    await auditLog(firmId, 'company_archive', `Archived: ${rows[0].company_name}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /companies/id/:id/archive error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies/id/:id/restore — restore an archived company
router.post('/companies/id/:id([0-9]+)/restore', async (req, res) => {
  const firmId = req.firm?.id;
  const companyId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      'SELECT company_name FROM companies WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    await pool.query(
      'UPDATE companies SET archived_at = NULL WHERE id = $1 AND firm_id = $2',
      [companyId, firmId]
    );
    await auditLog(firmId, 'company_restore', `Restored: ${rows[0].company_name}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /companies/id/:id/restore error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect QBO from a company without deleting the company record
router.post('/companies/:id([0-9]+)/disconnect-qbo', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT id, company_name, realm_id
       FROM companies
       WHERE id = $1 AND firm_id = $2
       LIMIT 1`,
      [id, firmId]
    );

    const company = rows[0];
    if (!company) return res.status(404).json({ error: 'Company not found' });

    await pool.query(
      `UPDATE companies
       SET access_token = '',
           refresh_token = '',
           token_expires_at = 0,
           connected_at = NULL,
           last_sync_at = NULL
       WHERE id = $1 AND firm_id = $2`,
      [id, firmId]
    );

    await auditLog(firmId, 'company_disconnect_qbo', `Disconnected QBO: ${company.company_name || company.realm_id || id}`, req.ip);
    res.json({ ok: true, company_id: company.id, realm_id: company.realm_id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Uncategorized transaction scan ---
router.post('/companies/:realmId/scan/uncategorized', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const result = await scanUncategorized(req.params.realmId);
    await auditLog(firmId, 'scan_uncategorized', `Realm: ${req.params.realmId}, flags: ${result.summary.flaggedCount}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- P&L Variance Analysis ---
router.post('/companies/:realmId/scan/variance', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { year, month, thresholdPct, thresholdAmt } = req.body || {};
    const result = await scanVariance(req.params.realmId, { year, month, thresholdPct, thresholdAmt });
    await auditLog(firmId, 'scan_variance', `Realm: ${req.params.realmId}, flags: ${result.summary.flaggedCount}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- Liability Account Health Check ---
router.post('/companies/:realmId/scan/liability', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const result = await scanLiabilities(req.params.realmId);
    await auditLog(firmId, 'scan_liability', `Realm: ${req.params.realmId}, flags: ${result.summary?.flaggedCount || 0}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get latest scan results (any type)
router.get('/companies/:realmId/scans', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { type } = req.query;
    if (type) {
      const result = await getLatestScan(req.params.realmId, type);
      res.json(result || { message: 'No scan results found' });
    } else {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (scan_type) *
        FROM scan_results
        WHERE realm_id = $1
        ORDER BY scan_type, scanned_at DESC
      `, [req.params.realmId]);
      res.json(rows);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Close package endpoints ---

router.post('/companies/:realmId/close-package', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { startDate, endDate, period, label, byMonth } = req.body;
    const realmId = req.params.realmId;

    if (byMonth && startDate && endDate) {
      const results = [];
      const start = new Date(startDate + 'T00:00:00');
      const end = new Date(endDate + 'T00:00:00');
      const cur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cur <= end) {
        const y = cur.getFullYear();
        const m = cur.getMonth() + 1;
        const p = y + '-' + String(m).padStart(2, '0');
        const pkg = await generateClosePackage(realmId, p);
        results.push(pkg);
        cur.setMonth(cur.getMonth() + 1);
      }
      return res.json(results);
    }

    if (startDate && endDate) {
      const pkg = await generateClosePackage(realmId, period || 'custom', startDate, endDate);
      return res.json(pkg);
    }

    const p = period || defaultClosePackagePeriod();
    const pkg = await generateClosePackage(realmId, p);
    res.json(pkg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/companies/id/:id([0-9]+)/ledgerhq/close-package', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    const companyId = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT id FROM companies
       WHERE id = $1 AND firm_id = $2
       LIMIT 1`,
      [companyId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });

    const { startDate, endDate, period, byMonth } = req.body || {};

    if (byMonth && startDate && endDate) {
      const results = [];
      const start = new Date(startDate + 'T00:00:00');
      const end = new Date(endDate + 'T00:00:00');
      const cur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cur <= end) {
        const y = cur.getFullYear();
        const m = cur.getMonth() + 1;
        const p = y + '-' + String(m).padStart(2, '0');
        const pkg = await generateClosePackageForProvider({ provider: 'ledgerhq', companyId, firmId, period: p });
        results.push(pkg);
        cur.setMonth(cur.getMonth() + 1);
      }
      return res.json(results);
    }

    const pkg = await generateClosePackageForProvider({
      provider: 'ledgerhq',
      companyId,
      firmId,
      period: period || defaultClosePackagePeriod(),
      startDate,
      endDate,
    });
    res.json(pkg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/id/:id([0-9]+)/ledgerhq/close-packages', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    const companyId = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT id FROM companies
       WHERE id = $1 AND firm_id = $2
       LIMIT 1`,
      [companyId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });

    const packages = await listLedgerHqClosePackages(companyId, firmId);
    res.json(packages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /companies/:realmId/tax-financials ─────────────────────────────────
// Generate year-end financial statements PDF (P&L, BS, TB) and save to docs tab
router.post('/companies/:realmId/tax-financials', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    const realmId = req.params.realmId;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const { year } = req.body;
    const taxYear = parseInt(year) || new Date().getFullYear() - 1;

    // Look up company info
    const { rows: companies } = await pool.query(
      'SELECT id, company_name, entity_type, relationship_id FROM companies WHERE realm_id = $1 AND firm_id = $2',
      [realmId, firmId]
    );
    if (!companies.length) return res.status(404).json({ error: 'Company not found' });
    const company = companies[0];

    // Generate PDF
    const { pdfBuffer, generatedAt } = await generateTaxFinancialsPdf({
      realmId,
      companyName: company.company_name || 'Company',
      entityType: company.entity_type,
      taxYear,
      firmId,
    });

    // Upload to S3
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = (company.company_name || 'company').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const s3Key = buildKey({
      firmId,
      ownerType: 'company',
      ownerId: company.id,
      filename: `${safeName}-${taxYear}-financials-${timestamp}.pdf`,
    });
    const bucket = process.env.AWS_S3_BUCKET;
    await uploadFile({ firmId: req.firm.id, buffer: pdfBuffer, key: s3Key, mimeType: 'application/pdf', bucket });

    // Save to documents table
    const displayName = `${company.company_name || 'Company'} — ${taxYear} Year-End Financials`;
    const { rows: docs } = await pool.query(`
      INSERT INTO documents
        (firm_id, owner_type, owner_id, year, doc_type, display_name,
         s3_key, s3_bucket, mime_type, size_bytes,
         uploaded_by_type, uploaded_by_id,
         folder_section, folder_category, created_at)
      VALUES ($1, 'company', $2, $3, 'financial_statements', $4, $5, $6, 'application/pdf', $7, 'staff', $8, 'firm_uploaded', 'tax', NOW())
      RETURNING id, display_name, created_at
    `, [
      firmId,
      company.id,
      String(taxYear),
      displayName,
      s3Key,
      bucket,
      pdfBuffer.length,
      req.firm?.userId || null,
    ]);

    const savedDoc = docs[0];

    // Fire pipeline trigger — against the company entity
    // Also fire against each person in the relationship if available
    const triggerCtx = {
      document_id: savedDoc.id,
      document_name: savedDoc.display_name,
      tax_year: String(taxYear),
      company_id: company.id,
    };

    // Fire trigger against the company only — pipeline entity type filtering
    // in fireTrigger ensures this only activates company-type pipelines
    fireTrigger(firmId, 'tax_financials_generated', company.id, triggerCtx, 'company')
      .catch(e => console.error('[tax-financials] fireTrigger non-fatal:', e));

    res.json({ success: true, document: savedDoc, generatedAt });
  } catch (err) {
    console.error('[tax-financials] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/:realmId/close-packages', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { rows } = await pool.query(
      'SELECT id, period, status, report_data, generated_at FROM close_packages WHERE realm_id = $1 ORDER BY generated_at DESC',
      [req.params.realmId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/:realmId/close-packages/:id', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { rows } = await pool.query(
      'SELECT * FROM close_packages WHERE id = $1 AND realm_id = $2',
      [req.params.id, req.params.realmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/companies/:realmId/close-packages/:id', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { status, reviewer_notes } = req.body;
    const updates = [];
    const params = [req.params.id, req.params.realmId];
    let idx = 3;

    if (status) {
      updates.push(`status = $${idx++}`);
      params.push(status);
    }
    if (reviewer_notes !== undefined) {
      updates.push(`reviewer_notes = $${idx++}`);
      params.push(reviewer_notes);
    }

    if (updates.length === 0) return res.json({ ok: true });

    await pool.query(
      `UPDATE close_packages SET ${updates.join(', ')} WHERE id = $1 AND realm_id = $2`,
      params
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// --- Chart of Accounts ---
router.get('/companies/:realmId/accounts', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const accounts = await getChartOfAccounts(req.params.realmId);
    // Return simplified structure grouped by type
    const simplified = accounts.map(a => ({
      id: a.Id,
      name: a.Name,
      fullName: a.FullyQualifiedName || a.Name,
      type: a.AccountType,
      subType: a.AccountSubType,
      active: a.Active !== false,
    }));
    res.json(simplified);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Transaction Drill-Down ---
router.get('/companies/:realmId/transactions/drilldown', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { account, startDate, endDate } = req.query;
    if (!account || !startDate || !endDate) {
      return res.status(400).json({ error: 'account, startDate, and endDate are required' });
    }

    // Use GeneralLedger report — correctly filters by account, unlike TransactionList
    // minorversion=3 required for GeneralLedger account_name filter to work
    const endpoint = `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account_name=${encodeURIComponent(account)}&minorversion=3`;
    console.log('[drilldown] GL endpoint:', endpoint);
    const data = await qbFetch(req.params.realmId, endpoint);
    console.log('[drilldown] colHeaders:', (data.Columns?.Column || []).map(c => c.ColTitle));
    const totalRows = (data.Rows?.Row || []).length;
    console.log('[drilldown] total top-level rows:', totalRows);
    if (data.Rows?.Row?.[0]) console.log('[drilldown] first row:', JSON.stringify(data.Rows.Row[0]).substring(0, 400));

    // Parse GeneralLedger report
    // GL structure: Section rows (one per account) containing Data rows (transactions)
    // Columns: Date, Transaction Type, Num, Name, Memo/Description, Split, Amount, Balance
    const colHeaders = (data.Columns?.Column || []).map(c => (c.ColTitle || '').toLowerCase().trim());
    const idx = {
      date:   colHeaders.findIndex(h => h === 'date'),
      type:   colHeaders.findIndex(h => h.includes('type')),
      num:    colHeaders.findIndex(h => h === 'num' || h.includes('num')),
      name:   colHeaders.findIndex(h => h === 'name'),
      memo:   colHeaders.findIndex(h => h.includes('memo') || h.includes('description')),
      split:  colHeaders.findIndex(h => h === 'split'),
      amount: colHeaders.findIndex(h => h === 'amount'),
    };
    if (idx.date === -1)   idx.date   = 0;
    if (idx.type === -1)   idx.type   = 1;
    if (idx.num  === -1)   idx.num    = 2;
    if (idx.name === -1)   idx.name   = 3;
    if (idx.memo === -1)   idx.memo   = 4;
    if (idx.split === -1)  idx.split  = 5;
    if (idx.amount === -1) idx.amount = 6;

    const rows = data.Rows?.Row || [];
    const transactions = [];

    // GL returns one Section per account. Filter to only the section(s) matching our account.
    // Match on the section Header's first ColData value (account name), case-insensitive partial match.
    const accountLower = account.toLowerCase();

    function parseGLSection(row) {
      // Only parse rows from sections whose header matches the requested account
      if (row.ColData) {
        const cols = row.ColData;
        const dateVal = cols[idx.date]?.value || '';
        if (!dateVal || dateVal === 'Beginning Balance') return; // skip balance rows
        const amount = parseFloat(cols[idx.amount]?.value || '0');
        if (amount === 0) return;
        transactions.push({
          date:   dateVal,
          type:   cols[idx.type]?.value  || '',
          num:    cols[idx.num]?.value   || '',
          name:   cols[idx.name]?.value  || '',
          memo:   cols[idx.memo]?.value  || '',
          split:  cols[idx.split]?.value || '',
          amount,
          // GL: transaction ID is on the type column's id field (e.g. {"value":"Expense","id":"3178"})
          txnId:  cols[idx.type]?.id || cols[idx.date]?.id || cols[0]?.id || '',
        });
      } else if ((row.type === 'Section' || row.group) && row.Rows?.Row) {
        row.Rows.Row.forEach(parseGLSection);
      }
    }

    for (const row of rows) {
      if (row.type === 'Section' || row.group) {
        // Check if this section's header matches our account name
        const sectionName = (row.Header?.ColData?.[0]?.value || '').toLowerCase();
        const matches = sectionName.includes(accountLower) || accountLower.includes(sectionName.split(' ')[0]);
        console.log('[drilldown] section:', sectionName, '| matches:', matches);
        if (matches && row.Rows?.Row) {
          row.Rows.Row.forEach(parseGLSection);
        }
      }
    }

    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Transaction Recode ---
router.post('/companies/:realmId/transactions/recode', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { txnId, txnType, newAccount } = req.body;
    if (!txnId || !newAccount) return res.status(400).json({ error: 'txnId and newAccount are required' });

    await writeBackTransaction(req.params.realmId, txnId, newAccount, txnType);

    await auditLog(
      firmId,
      'transaction_recode',
      `Realm: ${req.params.realmId}, txnId: ${txnId}, type: ${txnType || 'Purchase'}, account: ${newAccount}`,
      req.ip
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== STATEMENT ACCOUNT TRACKER =====

// GET /api/companies/:realmId/statements/accounts — QBO auto-pull + merge with saved schedules
router.get('/companies/:realmId/statements/accounts', async (req, res) => {
  try {
    const { realmId } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const month = req.query.month || currentPeriod();

    // Pull relevant accounts from QBO
    let qboAccounts = [];
    try {
      const allAccounts = await getChartOfAccounts(realmId);
      const relevantTypes = ['Bank', 'Credit Card', 'Long Term Liability', 'Other Current Liability'];
      const relevantSubTypes = ['Checking', 'Savings', 'MoneyMarket', 'LineOfCredit', 'Loan', 'CreditCard',
        'LoanPayable', 'NotesPayable', 'OtherCurrentLiabilities', 'Trust', 'Vehicle', 'Equipment'];
      qboAccounts = allAccounts.filter(a => {
        const type = a.AccountType || '';
        const subType = a.AccountSubType || '';
        const balance = a.CurrentBalance || 0;
        if (relevantTypes.includes(type) && balance !== 0) return true;
        if (relevantSubTypes.includes(subType)) return true;
        return false;
      });
    } catch (qboErr) {
      // QBO unavailable — fall through to return saved schedules only
    }

    // Load existing schedules for this realm + monthly status
    const { rows: saved } = await pool.query(
      `SELECT ss.*,
         COALESCE(sms.status, 'pending') AS monthly_status,
         sms.received_at AS monthly_received_at,
         COALESCE(sms.notes, '') AS monthly_notes,
         sms.id AS monthly_status_id
       FROM statement_schedules ss
       LEFT JOIN statement_monthly_status sms
         ON sms.schedule_id = ss.id AND sms.month = $2
       WHERE ss.realm_id = $1
       ORDER BY ss.account_name ASC`,
      [realmId, month]
    );

    // Build a map of saved schedules by qb_account_id and account_name
    const savedByQbId = {};
    const savedByName = {};
    for (const s of saved) {
      if (s.qb_account_id) savedByQbId[s.qb_account_id] = s;
      savedByName[s.account_name] = s;
    }

    // Merge QBO accounts with saved schedules
    const merged = [];
    const seenIds = new Set();

    for (const qa of qboAccounts) {
      const qbId = String(qa.Id || '');
      const name = qa.FullyQualifiedName || qa.Name;
      const existing = savedByQbId[qbId] || savedByName[name];
      if (existing) {
        seenIds.add(existing.id);
        merged.push({ ...existing, qb_account_id: qbId, _from_qbo: true,
          accountType: qa.AccountType, accountSubType: qa.AccountSubType, balance: qa.CurrentBalance });
      } else {
        merged.push({
          id: null, realm_id: realmId, account_name: name, institution: '',
          access_method: 'qbo_pull', statement_day: 1, notes: '', qb_account_id: qbId,
          monthly_status: 'pending', monthly_received_at: null, monthly_notes: '',
          _from_qbo: true, _new: true,
          accountType: qa.AccountType, accountSubType: qa.AccountSubType, balance: qa.CurrentBalance
        });
      }
    }

    // Also include manually-added accounts not from QBO
    for (const s of saved) {
      if (!seenIds.has(s.id)) {
        merged.push({ ...s, _manual: true });
      }
    }

    // Sort: by account_name
    merged.sort((a, b) => (a.account_name || '').localeCompare(b.account_name || ''));

    // Compute months_behind for each account
    const currentMon = currentPeriod();
    for (const acct of merged) {
      if (!acct.id) { acct.months_behind = 0; continue; }
      const lrm = acct.last_retrieved_month || '';
      if (!lrm) {
        acct.months_behind = 0;
      } else {
        const [cy, cm] = currentMon.split('-').map(Number);
        const [ly, lm] = lrm.split('-').map(Number);
        acct.months_behind = (cy - ly) * 12 + (cm - lm);
      }
    }

    // For client_upload accounts with start_month, compute pending_count
    function monthRange(startMonth) {
      const months = [];
      if (!startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) return months;
      const now = new Date();
      const endDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      let cur = new Date(parseInt(startMonth.split('-')[0]), parseInt(startMonth.split('-')[1]) - 1, 1);
      while (cur <= endDate) {
        months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
      }
      return months;
    }

    const clientUploadIds = merged.filter(a => a.id && a.access_method === 'client_upload' && a.start_month).map(a => a.id);
    if (clientUploadIds.length) {
      const { rows: uploadStatuses } = await pool.query(
        `SELECT schedule_id, month, status FROM statement_monthly_status
         WHERE schedule_id = ANY($1)`,
        [clientUploadIds]
      );
      const uploadedBySchedule = {};
      for (const us of uploadStatuses) {
        if (!uploadedBySchedule[us.schedule_id]) uploadedBySchedule[us.schedule_id] = new Set();
        if (['uploaded','received'].includes(us.status)) uploadedBySchedule[us.schedule_id].add(us.month);
      }
      for (const acct of merged) {
        if (acct.id && acct.access_method === 'client_upload' && acct.start_month) {
          const allMonths = monthRange(acct.start_month);
          const uploaded = uploadedBySchedule[acct.id] || new Set();
          acct.pending_count = allMonths.filter(m => !uploaded.has(m)).length;
        }
      }
    }

    res.json({ month, accounts: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/companies/:realmId/statements — return schedules for this realm + current month
router.get('/companies/:realmId/statements', async (req, res) => {
  try {
    const { realmId } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const month = req.query.month || currentPeriod();
    const { rows } = await pool.query(
      `SELECT ss.*,
         COALESCE(sms.status, 'pending') AS monthly_status,
         sms.received_at AS monthly_received_at,
         COALESCE(sms.notes, '') AS monthly_notes,
         sms.id AS monthly_status_id
       FROM statement_schedules ss
       LEFT JOIN statement_monthly_status sms
         ON sms.schedule_id = ss.id AND sms.month = $2
       WHERE ss.realm_id = $1
       ORDER BY ss.account_name ASC`,
      [realmId, month]
    );
    res.json({ month, accounts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies/:realmId/statements — upsert a statement_schedule row
router.post('/companies/:realmId/statements', async (req, res) => {
  try {
    const { realmId } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const { account_name, institution, access_method, statement_day, start_month, notes, client_name, contact_email, qb_account_id } = req.body;
    if (!account_name) return res.status(400).json({ error: 'account_name is required' });

    const { rows } = await pool.query(
      `INSERT INTO statement_schedules (realm_id, client_name, account_name, institution, access_method, statement_day, start_month, notes, contact_email, qb_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (realm_id, account_name) DO UPDATE SET
         institution = COALESCE(NULLIF(EXCLUDED.institution,''), statement_schedules.institution),
         access_method = EXCLUDED.access_method,
         statement_day = EXCLUDED.statement_day,
         start_month = COALESCE(NULLIF(EXCLUDED.start_month,''), statement_schedules.start_month),
         notes = COALESCE(NULLIF(EXCLUDED.notes,''), statement_schedules.notes),
         contact_email = COALESCE(NULLIF(EXCLUDED.contact_email,''), statement_schedules.contact_email),
         qb_account_id = COALESCE(NULLIF(EXCLUDED.qb_account_id,''), statement_schedules.qb_account_id)
       RETURNING *`,
      [realmId, client_name || '', account_name, institution || '', access_method || 'qbo_pull', statement_day || 1, start_month || '', notes || '', contact_email || '', qb_account_id || '']
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/companies/:realmId/statements/:id — update fields
router.put('/companies/:realmId/statements/:id', async (req, res) => {
  try {
    const { realmId, id } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const { account_name, institution, access_method, statement_day, start_month, notes, status, client_name, contact_email, qb_account_id } = req.body;
    const { rows } = await pool.query(
      `UPDATE statement_schedules SET
         account_name = COALESCE($1, account_name),
         institution = COALESCE($2, institution),
         access_method = COALESCE($3, access_method),
         statement_day = COALESCE($4, statement_day),
         start_month = CASE WHEN $5::TEXT IS NOT NULL THEN $5::TEXT ELSE start_month END,
         notes = COALESCE($6, notes),
         client_name = COALESCE($7, client_name),
         contact_email = COALESCE($8, contact_email),
         qb_account_id = COALESCE($9, qb_account_id)
       WHERE id = $10 AND realm_id = $11
       RETURNING *`,
      [account_name, institution, access_method, statement_day, start_month !== undefined ? (start_month || '') : null, notes, client_name, contact_email, qb_account_id, id, realmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/companies/:realmId/statements/:id/uploads — month-by-month upload status for a client_upload account
router.get('/companies/:realmId/statements/:id/uploads', async (req, res) => {
  try {
    const { realmId, id } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const { rows: schedRows } = await pool.query(
      'SELECT id, account_name, start_month FROM statement_schedules WHERE id = $1 AND realm_id = $2',
      [id, realmId]
    );
    if (!schedRows.length) return res.status(404).json({ error: 'Not found' });
    const sched = schedRows[0];

    // Generate month range
    function monthRange(startMonth) {
      const months = [];
      if (!startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) return months;
      const now = new Date();
      const endDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      let cur = new Date(parseInt(startMonth.split('-')[0]), parseInt(startMonth.split('-')[1]) - 1, 1);
      while (cur <= endDate) {
        months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
      }
      return months;
    }

    const months = monthRange(sched.start_month);
    const { rows: statuses } = await pool.query(
      `SELECT month, status, received_at, document_id FROM statement_monthly_status
       WHERE schedule_id = $1 ORDER BY month ASC`,
      [id]
    );
    const statusMap = {};
    for (const s of statuses) statusMap[s.month] = s;

    const result = months.map(m => {
      const st = statusMap[m];
      return { month: m, status: st ? st.status : 'pending', received_at: st ? st.received_at : null, document_id: st ? st.document_id : null };
    });

    const pendingCount = result.filter(m => !['uploaded','received'].includes(m.status)).length;
    res.json({ account_name: sched.account_name, start_month: sched.start_month, months: result, pending_count: pendingCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies/:realmId/statements/:id/retrieve — mark retrieved for current month
router.post('/companies/:realmId/statements/:id/retrieve', async (req, res) => {
  try {
    const { realmId, id } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const month = currentPeriod();

    const { rows: schedRows } = await pool.query(
      'SELECT id FROM statement_schedules WHERE id = $1 AND realm_id = $2',
      [id, realmId]
    );
    if (schedRows.length === 0) return res.status(404).json({ error: 'Statement account not found' });

    const { rows } = await pool.query(
      `INSERT INTO statement_monthly_status (schedule_id, realm_id, month, status, received_at, updated_at)
       VALUES ($1, $2, $3, 'received', NOW(), NOW())
       ON CONFLICT (schedule_id, month) DO UPDATE SET
         status = 'received',
         received_at = COALESCE(statement_monthly_status.received_at, NOW()),
         updated_at = NOW()
       RETURNING *`,
      [id, realmId, month]
    );

    // Also update statement_schedules for convenience
    await pool.query(
      `UPDATE statement_schedules SET status = 'received', received_at = NOW(), current_month = $3 WHERE id = $1 AND realm_id = $2`,
      [id, realmId, month]
    );

    res.json({ ok: true, month, status: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/companies/:realmId/statements/:id — delete an account
router.delete('/companies/:realmId/statements/:id', async (req, res) => {
  try {
    const { realmId, id } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const { rowCount } = await pool.query(
      'DELETE FROM statement_schedules WHERE id = $1 AND realm_id = $2',
      [id, realmId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy: import from QBO (kept for backwards compat)
router.post('/companies/:realmId/statements/import-qbo', async (req, res) => {
  try {
    const { realmId } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const allAccounts = await getChartOfAccounts(realmId);
    const relevantTypes = ['Bank', 'Credit Card', 'Long Term Liability', 'Other Current Liability'];
    const relevantSubTypes = ['Checking', 'Savings', 'MoneyMarket', 'LineOfCredit', 'Loan', 'CreditCard',
      'LoanPayable', 'NotesPayable', 'OtherCurrentLiabilities', 'Trust', 'Vehicle', 'Equipment'];
    const relevant = allAccounts.filter(a => {
      const type = a.AccountType || '';
      const subType = a.AccountSubType || '';
      return relevantTypes.includes(type) || relevantSubTypes.includes(subType);
    });

    let imported = 0;
    for (const acct of relevant) {
      const accountName = acct.FullyQualifiedName || acct.Name;
      const qbId = String(acct.Id || '');
      try {
        await pool.query(
          `INSERT INTO statement_schedules (realm_id, client_name, account_name, institution, access_method, qb_account_id)
           VALUES ($1, '', $2, '', 'qbo_pull', $3)
           ON CONFLICT (realm_id, account_name) DO UPDATE SET qb_account_id = COALESCE(NULLIF(EXCLUDED.qb_account_id,''), statement_schedules.qb_account_id)`,
          [realmId, accountName, qbId]
        );
        imported++;
      } catch (e) { /* skip */ }
    }

    const { rows } = await pool.query(
      'SELECT * FROM statement_schedules WHERE realm_id = $1 ORDER BY account_name ASC',
      [realmId]
    );
    res.json({ ok: true, imported, accounts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy: get monthly status (kept for compat)
router.get('/companies/:realmId/statements/monthly', async (req, res) => {
  try {
    const { realmId } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const month = req.query.month || currentPeriod();
    const { rows } = await pool.query(
      `SELECT ss.*,
         COALESCE(sms.status, 'pending') AS monthly_status,
         sms.received_at AS monthly_received_at,
         COALESCE(sms.notes, '') AS monthly_notes,
         sms.id AS monthly_id
       FROM statement_schedules ss
       LEFT JOIN statement_monthly_status sms
         ON sms.schedule_id = ss.id AND sms.month = $2
       WHERE ss.realm_id = $1
       ORDER BY ss.account_name ASC`,
      [realmId, month]
    );
    res.json({ month, accounts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy: update monthly status for a specific account+month
router.put('/companies/:realmId/statements/:id/monthly/:month', async (req, res) => {
  try {
    const { realmId, id, month } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const { status, notes } = req.body;

    const { rows: schedRows } = await pool.query(
      'SELECT id FROM statement_schedules WHERE id = $1 AND realm_id = $2',
      [id, realmId]
    );
    if (schedRows.length === 0) return res.status(404).json({ error: 'Statement account not found' });

    const received_at = status === 'received' || status === 'uploaded' ? new Date() : null;

    const { rows } = await pool.query(
      `INSERT INTO statement_monthly_status (schedule_id, realm_id, month, status, notes, received_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (schedule_id, month) DO UPDATE SET
         status = EXCLUDED.status,
         notes = COALESCE(NULLIF(EXCLUDED.notes, ''), statement_monthly_status.notes),
         received_at = CASE WHEN EXCLUDED.status IN ('received','uploaded') AND statement_monthly_status.received_at IS NULL THEN NOW() ELSE statement_monthly_status.received_at END,
         updated_at = NOW()
       RETURNING *`,
      [id, realmId, month, status || 'pending', notes || '', received_at]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Firm-wide calendar: all companies + accounts grouped by statement_day
// Returns per-day summary: { day, total, retrieved, pending, items: [{id, realmId, companyName, accountName, method, isRetrieved, retrievedAt}] }
router.get('/statements/calendar', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    const month = req.query.month || currentPeriod();

    // Get all realm_ids for this firm
    let realmQuery, realmParams;
    if (firmId) {
      realmQuery = 'SELECT realm_id, company_name FROM companies WHERE firm_id = $1';
      realmParams = [firmId];
    } else {
      realmQuery = 'SELECT realm_id, company_name FROM companies';
      realmParams = [];
    }
    const { rows: companyRows } = await pool.query(realmQuery, realmParams);
    const realmIds = companyRows.map(r => r.realm_id);

    if (realmIds.length === 0) return res.json({ month, days: [], byDay: {} });

    const { rows } = await pool.query(
      `SELECT ss.id, ss.realm_id, ss.account_name, ss.access_method, ss.statement_day,
         c.company_name,
         COALESCE(sms.status, 'pending') AS monthly_status,
         sms.received_at AS monthly_received_at
       FROM statement_schedules ss
       JOIN companies c ON c.realm_id = ss.realm_id
       LEFT JOIN statement_monthly_status sms
         ON sms.schedule_id = ss.id AND sms.month = $2
       WHERE ss.realm_id = ANY($1)
       ORDER BY ss.statement_day ASC, c.company_name ASC, ss.account_name ASC`,
      [realmIds, month]
    );

    // Build per-day summaries
    const dayMap = {};
    for (const row of rows) {
      const day = row.statement_day || 1;
      if (!dayMap[day]) dayMap[day] = { day, total: 0, retrieved: 0, pending: 0, items: [] };
      const isRetrieved = row.monthly_status === 'received' || row.monthly_status === 'uploaded';
      dayMap[day].total++;
      if (isRetrieved) dayMap[day].retrieved++;
      else dayMap[day].pending++;
      dayMap[day].items.push({
        id: row.id,
        realmId: row.realm_id,
        companyName: row.company_name,
        accountName: row.account_name,
        method: row.access_method,
        isRetrieved,
        retrievedAt: row.monthly_received_at || null,
      });
    }

    const days = Object.values(dayMap).sort((a, b) => a.day - b.day);
    // Keep byDay for backwards compat
    const byDay = {};
    for (const d of days) byDay[d.day] = d.items;

    res.json({ month, days, byDay });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/companies/:realmId/statements/:id/mark-current
router.put('/companies/:realmId/statements/:id/mark-current', async (req, res) => {
  try {
    const { realmId, id } = req.params;
    const firmId = req.firm?.id;
    if (!(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const currentMonth = currentPeriod();

    const { rows: schedRows } = await pool.query(
      'SELECT id, last_retrieved_month FROM statement_schedules WHERE id = $1 AND realm_id = $2',
      [id, realmId]
    );
    if (schedRows.length === 0) return res.status(404).json({ error: 'Statement account not found' });

    // Update last_retrieved_month on the schedule
    await pool.query(
      `UPDATE statement_schedules SET last_retrieved_month = $1, status = 'received', received_at = NOW(), current_month = $1 WHERE id = $2 AND realm_id = $3`,
      [currentMonth, id, realmId]
    );

    // Mark all monthly status entries for this account in prior months as received (or upsert current month)
    // First upsert current month
    await pool.query(
      `INSERT INTO statement_monthly_status (schedule_id, realm_id, month, status, received_at, updated_at)
       VALUES ($1, $2, $3, 'received', NOW(), NOW())
       ON CONFLICT (schedule_id, month) DO UPDATE SET status = 'received', received_at = COALESCE(statement_monthly_status.received_at, NOW()), updated_at = NOW()`,
      [id, realmId, currentMonth]
    );

    // Mark all prior pending months as received too
    await pool.query(
      `UPDATE statement_monthly_status SET status = 'received', received_at = COALESCE(received_at, NOW()), updated_at = NOW()
       WHERE schedule_id = $1 AND realm_id = $2 AND month < $3 AND status = 'pending'`,
      [id, realmId, currentMonth]
    );

    const { rows } = await pool.query(
      'SELECT * FROM statement_schedules WHERE id = $1 AND realm_id = $2',
      [id, realmId]
    );

    res.json({ ok: true, account: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
