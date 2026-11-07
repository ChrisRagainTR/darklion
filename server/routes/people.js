const { Router } = require('express');
const { pool } = require('../db');
const { encrypt, decrypt } = require('../utils/encryption');
const crypto = require('crypto');
const { sendPasswordReset } = require('../services/email');

const PORTAL_URL = (process.env.PORTAL_URL || process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

const router = Router();

// Strip sensitive fields and add computed flags for GET responses
function sanitizePerson(row) {
  const person = { ...row };
  delete person.ssn_encrypted;
  delete person.ssn_last4;
  // Expose whether a password actually exists (without exposing the hash)
  person.portal_has_password = !!row.portal_password_hash;
  person.spouse_portal_has_password = !!row.spouse_portal_password_hash;
  delete person.portal_password_hash;
  delete person.spouse_portal_password_hash;
  for (const key of Object.keys(person)) {
    if (/(?:invite_token|reset_token|password_hash|mfa_secret)/i.test(key)) delete person[key];
  }
  // Decrypt DOB for staff display
  if (row.date_of_birth_encrypted) {
    try { person.date_of_birth = decrypt(row.date_of_birth_encrypted); } catch(e) { person.date_of_birth = null; }
  } else {
    person.date_of_birth = null;
  }
  delete person.date_of_birth_encrypted;
  person.has_dob = !!person.date_of_birth;
  return person;
}

async function loadPersonPayload(personId, firmId) {
  const { rows } = await pool.query(
    `SELECT p.*, r.name AS relationship_name
     FROM people p
     LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = p.firm_id
     WHERE p.id = $1 AND p.firm_id = $2`,
    [personId, firmId]
  );
  if (rows.length === 0) return null;

  const person = sanitizePerson(rows[0]);
  const { rows: accessRows } = await pool.query(`
    SELECT
      pca.id,
      pca.company_id,
      pca.access_level,
      pca.ownership_pct,
      pca.created_at,
      c.company_name,
      c.entity_type,
      c.realm_id
    FROM person_company_access pca
    JOIN companies c ON c.id = pca.company_id AND c.firm_id = $2
    WHERE pca.person_id = $1
    ORDER BY c.company_name ASC
  `, [personId, firmId]);

  person.company_access = accessRows;
  return person;
}

// GET / — list all people for this firm (with relationship name)
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(`
      SELECT
        p.*,
        r.name AS relationship_name,
        COALESCE((
          SELECT SUM((SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL AND m.is_internal = false))
          FROM message_threads mt WHERE mt.person_id = p.id AND mt.firm_id = p.firm_id AND mt.status != 'archived'
        ), 0) AS unread_count
      FROM people p
      LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = p.firm_id
      WHERE p.firm_id = $1
      ORDER BY p.last_name ASC, p.first_name ASC
    `, [firmId]);
    res.json(rows.map(sanitizePerson));
  } catch (err) {
    console.error('GET /people error:', err);
    res.status(500).json({ error: 'Failed to fetch people' });
  }
});

// POST / — create a person
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  const {
    relationship_id,
    first_name = '',
    last_name = '',
    email = '',
    phone = '',
    filing_status = '',
    portal_enabled = false,
    stanford_tax_url = '',
    notes = '',
    date_of_birth,
    spouse_name = '',
    spouse_email = '',
    spouse_portal_enabled = false,
    address_line1 = '',
    address_line2 = '',
    city = '',
    state = '',
    zip = '',
  } = req.body;

  if (!relationship_id) return res.status(400).json({ error: 'relationship_id is required' });
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    // Verify relationship belongs to this firm
    const { rows: relRows } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
      [relationship_id, firmId]
    );
    if (relRows.length === 0) return res.status(404).json({ error: 'Relationship not found' });

    // Email uniqueness check — across people.email AND people.spouse_email
    const { rows: emailCheck } = await pool.query(
      `SELECT id, first_name, last_name FROM people
       WHERE firm_id = $1 AND (LOWER(email) = LOWER($2) OR LOWER(spouse_email) = LOWER($2))`,
      [firmId, email]
    );
    if (emailCheck.length > 0) {
      const clash = emailCheck[0];
      return res.status(409).json({ error: `That email is already in use by ${clash.first_name} ${clash.last_name}` });
    }

    // Spouse email uniqueness check
    if (spouse_email) {
      const { rows: spouseEmailCheck } = await pool.query(
        `SELECT id, first_name, last_name FROM people
         WHERE firm_id = $1 AND (LOWER(email) = LOWER($2) OR LOWER(spouse_email) = LOWER($2))`,
        [firmId, spouse_email]
      );
      if (spouseEmailCheck.length > 0) {
        const clash = spouseEmailCheck[0];
        return res.status(409).json({ error: `Spouse email is already in use by ${clash.first_name} ${clash.last_name}` });
      }
    }

    const date_of_birth_encrypted = date_of_birth ? encrypt(date_of_birth) : '';

    const { rows } = await pool.query(`
      INSERT INTO people (
        firm_id, relationship_id, first_name, last_name, email, phone,
        date_of_birth_encrypted,
        filing_status, portal_enabled, stanford_tax_url, notes,
        spouse_name, spouse_email, spouse_portal_enabled,
        address_line1, address_line2, city, state, zip,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), NOW())
      RETURNING *
    `, [
      firmId, relationship_id, first_name, last_name, email, phone,
      date_of_birth_encrypted,
      filing_status, portal_enabled, stanford_tax_url, notes,
      spouse_name, spouse_email, spouse_portal_enabled,
      address_line1, address_line2, city, state, zip,
    ]);

    const newPerson = rows[0];

    // Auto-grant portal access to all companies already in this relationship
    await pool.query(`
      INSERT INTO person_company_access (person_id, company_id, access_level)
      SELECT $1, c.id, 'full'
      FROM companies c
      WHERE c.relationship_id = $2 AND c.firm_id = $3
      ON CONFLICT (person_id, company_id) DO NOTHING
    `, [newPerson.id, relationship_id, firmId]).catch(e =>
      console.warn('[people] auto-grant company access non-fatal:', e.message)
    );

    res.status(201).json(sanitizePerson(newPerson));
  } catch (err) {
    console.error('POST /people error:', err);
    res.status(500).json({ error: 'Failed to create person' });
  }
});

// GET /:id — get a person with company access list
router.get('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const person = await loadPersonPayload(id, firmId);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    res.json(person);
  } catch (err) {
    console.error('GET /people/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch person' });
  }
});

// POST /:id/move-relationship — move person to another relationship and optionally sync company access
router.post('/:id/move-relationship', async (req, res) => {
  const firmId = req.firm.id;
  const personId = parseInt(req.params.id, 10);
  const relationshipId = parseInt(req.body?.relationship_id, 10);
  const syncCompanyAccess = req.body?.sync_company_access !== false;

  if (!personId) return res.status(400).json({ error: 'Invalid person id' });
  if (!relationshipId) return res.status(400).json({ error: 'relationship_id is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: personRows } = await client.query(
      'SELECT id, relationship_id, first_name, last_name FROM people WHERE id = $1 AND firm_id = $2 FOR UPDATE',
      [personId, firmId]
    );
    if (personRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Person not found' });
    }

    const { rows: relRows } = await client.query(
      'SELECT id, name FROM relationships WHERE id = $1 AND firm_id = $2',
      [relationshipId, firmId]
    );
    if (relRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Relationship not found' });
    }

    const previousRelationshipId = personRows[0].relationship_id;
    if (previousRelationshipId === relationshipId) {
      await client.query('COMMIT');
      return res.json({
        success: true,
        moved: false,
        person: await loadPersonPayload(personId, firmId),
      });
    }

    await client.query(
      'UPDATE people SET relationship_id = $1, updated_at = NOW() WHERE id = $2 AND firm_id = $3',
      [relationshipId, personId, firmId]
    );

    if (syncCompanyAccess) {
      await client.query(`
        INSERT INTO person_company_access (person_id, company_id, access_level)
        SELECT $1, c.id, 'full'
        FROM companies c
        WHERE c.relationship_id = $2 AND c.firm_id = $3 AND c.archived_at IS NULL
        ON CONFLICT (person_id, company_id) DO NOTHING
      `, [personId, relationshipId, firmId]);

      if (previousRelationshipId) {
        await client.query(`
          DELETE FROM person_company_access pca
          USING companies c
          WHERE pca.company_id = c.id
            AND pca.person_id = $1
            AND c.firm_id = $2
            AND c.relationship_id = $3
        `, [personId, firmId, previousRelationshipId]);
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      moved: true,
      previous_relationship_id: previousRelationshipId,
      relationship_id: relationshipId,
      relationship_name: relRows[0].name,
      person: await loadPersonPayload(personId, firmId),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /people/:id/move-relationship error:', err);
    res.status(500).json({ error: 'Failed to move person' });
  } finally {
    client.release();
  }
});

// PUT /:id — update a person
router.put('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const {
    relationship_id,
    first_name,
    last_name,
    email,
    phone,
    filing_status,
    portal_enabled,
    stanford_tax_url,
    notes,
    date_of_birth,
    billing_method,
    spouse_name,
    spouse_email,
    spouse_portal_enabled,
    address_line1,
    address_line2,
    city,
    state,
    zip,
    personal_tax_engaged,
  } = req.body;

  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Person not found' });

    // If relationship_id is being updated, verify it belongs to this firm
    if (relationship_id) {
      const { rows: relRows } = await pool.query(
        'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
        [relationship_id, firmId]
      );
      if (relRows.length === 0) return res.status(404).json({ error: 'Relationship not found' });
    }

    // Email uniqueness check (exclude self)
    if (email) {
      const { rows: emailCheck } = await pool.query(
        `SELECT id, first_name, last_name FROM people
         WHERE firm_id = $1 AND id != $2 AND (LOWER(email) = LOWER($3) OR LOWER(spouse_email) = LOWER($3))`,
        [firmId, id, email]
      );
      if (emailCheck.length > 0) {
        const clash = emailCheck[0];
        return res.status(409).json({ error: `That email is already in use by ${clash.first_name} ${clash.last_name}` });
      }
    }
    if (spouse_email) {
      const { rows: spouseEmailCheck } = await pool.query(
        `SELECT id, first_name, last_name FROM people
         WHERE firm_id = $1 AND id != $2 AND (LOWER(email) = LOWER($3) OR LOWER(spouse_email) = LOWER($3))`,
        [firmId, id, spouse_email]
      );
      if (spouseEmailCheck.length > 0) {
        const clash = spouseEmailCheck[0];
        return res.status(409).json({ error: `Spouse email is already in use by ${clash.first_name} ${clash.last_name}` });
      }
    }

    const date_of_birth_encrypted = date_of_birth !== undefined ? encrypt(date_of_birth) : undefined;

    const { rows } = await pool.query(`
      UPDATE people
      SET
        relationship_id = COALESCE($1, relationship_id),
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        email = COALESCE($4, email),
        phone = COALESCE($5, phone),
        filing_status = COALESCE($6, filing_status),
        portal_enabled = COALESCE($7, portal_enabled),
        stanford_tax_url = COALESCE($8, stanford_tax_url),
        notes = COALESCE($9, notes),
        date_of_birth_encrypted = CASE WHEN $10::TEXT IS NOT NULL THEN $10 ELSE date_of_birth_encrypted END,
        billing_method = COALESCE($13, billing_method),
        spouse_name = CASE WHEN $14::BOOLEAN THEN $15 ELSE spouse_name END,
        spouse_email = CASE WHEN $16::BOOLEAN THEN $17 ELSE spouse_email END,
        spouse_portal_enabled = CASE WHEN $18::BOOLEAN THEN $19 ELSE spouse_portal_enabled END,
        address_line1 = CASE WHEN $20::TEXT IS NOT NULL THEN $20 ELSE address_line1 END,
        address_line2 = CASE WHEN $21::TEXT IS NOT NULL THEN $21 ELSE address_line2 END,
        city = CASE WHEN $22::TEXT IS NOT NULL THEN $22 ELSE city END,
        state = CASE WHEN $23::TEXT IS NOT NULL THEN $23 ELSE state END,
        zip = CASE WHEN $24::TEXT IS NOT NULL THEN $24 ELSE zip END,
        personal_tax_engaged = CASE WHEN $25::BOOLEAN IS NOT NULL THEN $25 ELSE personal_tax_engaged END,
        updated_at = NOW()
      WHERE id = $11 AND firm_id = $12
      RETURNING *
    `, [
      relationship_id || null,
      first_name || null,
      last_name || null,
      email !== undefined ? email : null,
      phone !== undefined ? phone : null,
      filing_status || null,
      portal_enabled !== undefined ? portal_enabled : null,       // $7
      stanford_tax_url !== undefined ? stanford_tax_url : null,   // $8
      notes !== undefined ? notes : null,                          // $9
      date_of_birth_encrypted !== undefined ? date_of_birth_encrypted : null, // $10
      id,                                                          // $11
      firmId,                                                      // $12
      billing_method !== undefined ? (billing_method || null) : null, // $13
      spouse_name !== undefined,                                   // $14: was explicitly passed
      spouse_name !== undefined ? (spouse_name || '') : '',        // $15
      spouse_email !== undefined,                                  // $16
      spouse_email !== undefined ? (spouse_email || '') : '',      // $17
      spouse_portal_enabled !== undefined,                         // $18
      spouse_portal_enabled !== undefined ? !!spouse_portal_enabled : false, // $19
      address_line1 !== undefined ? (address_line1 || '') : null, // $20
      address_line2 !== undefined ? (address_line2 || '') : null, // $21
      city !== undefined ? (city || '') : null,                   // $22
      state !== undefined ? (state || '') : null,                 // $23
      zip !== undefined ? (zip || '') : null,                     // $24
      personal_tax_engaged !== undefined ? !!personal_tax_engaged : null, // $25
    ]);

    const updated = rows[0];

    res.json(sanitizePerson(updated));
  } catch (err) {
    console.error('PUT /people/:id error:', err);
    res.status(500).json({ error: 'Failed to update person' });
  }
});

// DELETE /:id — delete only if no portal activity
router.delete('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Person not found' });

    const person = existing[0];
    if (person.portal_last_login_at) {
      return res.status(409).json({ error: 'Cannot delete person with portal login history' });
    }

    // Remove company access first (cascade handles this, but explicit for clarity)
    await pool.query('DELETE FROM person_company_access WHERE person_id = $1', [id]);
    await pool.query('DELETE FROM people WHERE id = $1 AND firm_id = $2', [id, firmId]);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /people/:id error:', err);
    res.status(500).json({ error: 'Failed to delete person' });
  }
});

// POST /:id/company-access — grant company access
router.post('/:id/company-access', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const { company_id, access_level = 'full', ownership_pct } = req.body;

  if (!company_id) return res.status(400).json({ error: 'company_id is required' });

  try {
    // Verify person belongs to this firm
    const { rows: personRows } = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (personRows.length === 0) return res.status(404).json({ error: 'Person not found' });

    // Verify company belongs to this firm
    const { rows: companyRows } = await pool.query(
      'SELECT id FROM companies WHERE id = $1 AND firm_id = $2',
      [company_id, firmId]
    );
    if (companyRows.length === 0) return res.status(404).json({ error: 'Company not found' });

    const { rows } = await pool.query(`
      INSERT INTO person_company_access (person_id, company_id, access_level, ownership_pct, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (person_id, company_id) DO UPDATE
        SET access_level = EXCLUDED.access_level,
            ownership_pct = EXCLUDED.ownership_pct
      RETURNING *
    `, [id, company_id, access_level, ownership_pct || null]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /people/:id/company-access error:', err);
    res.status(500).json({ error: 'Failed to grant company access' });
  }
});

// DELETE /:id/company-access/:companyId — revoke company access
router.delete('/:id/company-access/:companyId', async (req, res) => {
  const firmId = req.firm.id;
  const { id, companyId } = req.params;

  try {
    // Verify person belongs to this firm
    const { rows: personRows } = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (personRows.length === 0) return res.status(404).json({ error: 'Person not found' });

    const { rowCount } = await pool.query(
      'DELETE FROM person_company_access WHERE person_id = $1 AND company_id = $2',
      [id, companyId]
    );

    if (rowCount === 0) return res.status(404).json({ error: 'Access record not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /people/:id/company-access/:companyId error:', err);
    res.status(500).json({ error: 'Failed to revoke company access' });
  }
});

// ── POST /:id/portal-reset — staff-initiated password reset email ─────────────
router.post('/:id/portal-reset', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.email, p.first_name, p.last_name, p.portal_enabled, f.name AS firm_name
       FROM people p JOIN firms f ON f.id = p.firm_id
       WHERE p.id = $1 AND p.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Person not found' });
    const person = rows[0];

    if (!person.portal_enabled) {
      return res.status(400).json({ error: 'Portal is not enabled for this person' });
    }
    if (!person.email) {
      return res.status(400).json({ error: 'Person has no email address' });
    }

    // Generate reset token (same mechanism as forgot-password flow)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await pool.query(
      `UPDATE people SET portal_invite_token = $1, portal_invite_expires_at = $2 WHERE id = $3`,
      [resetToken, expires, id]
    );

    const resetUrl = `${PORTAL_URL}/portal-login?reset=${resetToken}`;

    try {
      await sendPasswordReset({
        to: person.email,
        name: `${person.first_name} ${person.last_name}`.trim(),
        firmName: person.firm_name,
        firmId,
        resetUrl,
      });
    } catch (emailErr) {
      console.error('[portal-reset] email failed (non-fatal):', emailErr.message);
      // Still return ok — token is set, they can use the link
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /people/:id/portal-reset error:', err);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// ── POST /:id/portal-disable — disable portal access ─────────────────────────
router.post('/:id/portal-disable', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rowCount } = await pool.query(
      `UPDATE people
       SET portal_enabled = false,
           portal_invite_token = NULL,
           portal_invite_expires_at = NULL
       WHERE id = $1 AND firm_id = $2`,
      [id, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Person not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /people/:id/portal-disable error:', err);
    res.status(500).json({ error: 'Failed to disable portal' });
  }
});

// --- POST /api/people/:id/portal-preview ---
// Generates a short-lived ghost portal token so a staff member can view the portal as a client.
// Token expires in 1 hour. Audit-logged. Does not enable portal, set a password, or send an invite.
router.post('/:id/portal-preview', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;
  const id = parseInt(req.params.id);
  const signerRole = req.body && req.body.spouse ? 'spouse' : 'taxpayer';

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.relationship_id,
              p.spouse_name, p.spouse_email,
              f.name AS firm_name
       FROM people p JOIN firms f ON f.id = p.firm_id
       WHERE p.id = $1 AND p.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Person not found' });
    const person = rows[0];

    if (signerRole === 'taxpayer' && !person.email) {
      return res.status(400).json({ error: 'Add a taxpayer email before previewing the portal.' });
    }
    if (signerRole === 'spouse' && !person.spouse_email) {
      return res.status(400).json({ error: 'Add a spouse email before previewing the spouse portal.' });
    }

    const previewEmail = signerRole === 'spouse' ? person.spouse_email : person.email;
    const previewName = signerRole === 'spouse'
      ? (person.spouse_name || 'Spouse')
      : `${person.first_name} ${person.last_name}`.trim();

    const jwt = require('jsonwebtoken');
    const previewStaff=await require('../services/accountSecurity').ensureAccount({firmId,kind:'staff',accountId:staffUserId});
    const token = jwt.sign(
      {
        personId: person.id,
        firmId,
        relationshipId: person.relationship_id || null,
        email: previewEmail,
        name: previewName,
        type: 'portal',
        signerRole,
        ghostedBy: staffUserId,       // marks this as a ghost session
        previewStaff: {av:previewStaff.version,sid:req.firm.sessionId},
        ghostedByName: req.firm.name || 'Staff',
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }             // short-lived — ghost sessions expire in 1 hour
    );

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (firm_id, actor_type, actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'staff', $2, 'portal_ghost_view', 'person', $3, $4)`,
      [firmId, staffUserId, id, JSON.stringify({ client: previewName, signerRole, preInvite: true })]
    ).catch(() => {}); // non-fatal

    const url = `${PORTAL_URL}/portal?preview_token=${token}`;

    res.json({ url });
  } catch (err) {
    console.error('POST /people/:id/portal-preview error:', err);
    res.status(500).json({ error: 'Failed to generate preview token' });
  }
});

module.exports = router;
