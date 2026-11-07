'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { fireTrigger } = require('../services/pipelineTriggers');
const { ensurePortalAccessForSignedProposal } = require('../services/portalAccess');
const { saveSignedProposalEngagementLetter } = require('../services/proposalArtifacts');

async function runSignedProposalAutomation({ proposalId, firmId, engagementType, ip, appUrl }) {
  const context = { proposal_id: proposalId, engagement_type: engagementType };

  // Save the signed LOE first. This resolves/creates the primary person for relationships
  // that did not have a person yet, so portal deployment and person triggers have a target.
  let saved = null;
  try {
    saved = await saveSignedProposalEngagementLetter(proposalId, firmId, { baseUrl: appUrl });
    if (!saved.ok) {
      console.warn('[proposals-public] signed LOE filing skipped:', saved.status, saved.reason);
    }
  } catch (e) {
    console.error('[proposals-public] signed LOE filing non-fatal:', e.message);
  }

  // Deploy portal access after filing so no-person relationships are repaired first.
  try {
    const deployment = await ensurePortalAccessForSignedProposal(proposalId, firmId, { ip, sendEmail: true });
    if (!deployment.ok) {
      console.warn('[proposals-public] portal deployment skipped:', deployment.status, deployment.reason);
    }
  } catch (e) {
    console.error('[proposals-public] portal deployment non-fatal:', e.message);
  }

  // Fire relationship-based onboarding pipeline triggers, plus legacy person triggers.
  try {
    const { rows: proposalRows } = await pool.query(
      `SELECT relationship_id FROM proposals WHERE id = $1 AND firm_id = $2`,
      [proposalId, firmId]
    );
    const relationshipId = proposalRows[0]?.relationship_id;
    if (relationshipId) {
      await fireTrigger(firmId, 'proposal_signed', relationshipId, context, 'relationship');
    }
  } catch (e) {
    console.error('[proposals-public] relationship proposal_signed trigger non-fatal:', e.message);
  }

  try {
    const { rows: relPeople } = await pool.query(
      `SELECT DISTINCT p.id AS person_id, pr.firm_id
       FROM proposals pr
       JOIN relationships r ON r.id = pr.relationship_id
       JOIN people p ON (p.relationship_id = r.id OR
         p.id IN (SELECT person_id FROM person_company_access pca
                  JOIN companies c ON c.id = pca.company_id
                  WHERE c.relationship_id = r.id))
       WHERE pr.id = $1`,
      [proposalId]
    );
    for (const row of relPeople) {
      fireTrigger(row.firm_id, 'proposal_signed', row.person_id, context, 'person')
        .catch(e => console.error('[proposals-public] person proposal_signed trigger non-fatal:', e.message));
    }
  } catch (e) {
    console.error('[proposals-public] person proposal_signed trigger lookup non-fatal:', e.message);
  }

}

// GET /:token — get proposal by public token
router.get('/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, title, client_name, client_email, client_phone,
              client_address, client_city_state_zip, engagement_type,
              tiers, add_ons, backwork, aum_fee_percent, require_dual_signature,
              status, expires_at, viewed_at, accepted_at
       FROM proposals
       WHERE public_token = $1`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Proposal not found' });
    const p = rows[0];

    // Check expiry
    if (p.expires_at && new Date(p.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This proposal has expired' });
    }

    // Mark as viewed if first time
    if (p.status === 'sent') {
      await pool.query(
        `UPDATE proposals SET status = 'viewed', viewed_at = NOW(), updated_at = NOW()
         WHERE public_token = $1 AND status = 'sent'`,
        [token]
      );
      p.status = 'viewed';
    }

    res.json(p);
  } catch (err) {
    console.error('GET /proposals/public/:token error:', err);
    res.status(500).json({ error: 'Failed to fetch proposal' });
  }
});

// POST /:token/accept — accept proposal (client submits info + package selection)
router.post('/:token/accept', async (req, res) => {
  const { token } = req.params;
  const {
    company_name = '',
    contact_name = '',
    contact_email = '',
    contact_phone = '',
    address_line1 = '',
    address_line2 = '',
    entity_type = '',
    owners = '',
    additional_notes = '',
    selected_tier_index,
    selected_tier_indices = [],
    selected_tier_names = [],
  } = req.body;

  try {
    const { rows: prop } = await pool.query(
      `SELECT id, firm_id, status, tiers, add_ons, backwork, aum_fee_percent,
              require_dual_signature, engagement_type, client_name, client_email, expires_at
       FROM proposals WHERE public_token = $1`,
      [token]
    );
    if (!prop.length) return res.status(404).json({ error: 'Proposal not found' });
    const p = prop[0];

    if (p.expires_at && new Date(p.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This proposal has expired' });
    }
    if (['accepted', 'signed'].includes(p.status)) {
      return res.status(409).json({ error: 'Proposal already accepted' });
    }

    // Calculate monthly price
    const tiers = p.tiers || [];
    let monthlyPrice = 0;
    if (p.engagement_type === 'tax') {
      const tier = tiers[selected_tier_index];
      monthlyPrice = tier ? (parseFloat(tier.price) || 0) : 0;
    } else {
      // wealth: sum selected tiers
      const indices = Array.isArray(selected_tier_indices) ? selected_tier_indices : [];
      monthlyPrice = indices.reduce((sum, idx) => {
        const t = tiers[idx];
        return sum + (t ? (parseFloat(t.price) || 0) : 0);
      }, 0);
    }

    // Delete old acceptance if any
    await pool.query('DELETE FROM proposal_acceptances WHERE proposal_id = $1', [p.id]);
    await pool.query('DELETE FROM proposal_engagements WHERE proposal_id = $1', [p.id]);

    // Insert acceptance
    await pool.query(
      `INSERT INTO proposal_acceptances (
        proposal_id, company_name, contact_name, contact_email, contact_phone,
        address_line1, address_line2, entity_type, owners, additional_notes,
        selected_tier_index, selected_tier_indices, selected_tier_names
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        p.id, company_name, contact_name, contact_email, contact_phone,
        address_line1, address_line2, entity_type, owners, additional_notes,
        selected_tier_index !== undefined ? selected_tier_index : null,
        JSON.stringify(selected_tier_indices),
        JSON.stringify(selected_tier_names),
      ]
    );

    // Create engagement record
    await pool.query(
      `INSERT INTO proposal_engagements (
        proposal_id, firm_id, engagement_type, status,
        client_name, contact_name, company_name, contact_email,
        address_line1, address_line2, entity_type, owners,
        monthly_price, selected_tier_index, selected_tier_indices,
        tiers, add_ons, backwork, aum_fee_percent, require_dual_signature
      ) VALUES ($1,$2,$3,'pending_signature',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        p.id, p.firm_id, p.engagement_type,
        p.client_name, contact_name, company_name, p.client_email || contact_email,
        address_line1, address_line2, entity_type, owners,
        monthlyPrice,
        selected_tier_index !== undefined ? selected_tier_index : null,
        JSON.stringify(selected_tier_indices),
        JSON.stringify(tiers),
        JSON.stringify(p.add_ons || []),
        JSON.stringify(p.backwork || []),
        p.aum_fee_percent || 0.69,
        p.require_dual_signature || false,
      ]
    );

    // Update proposal status
    await pool.query(
      `UPDATE proposals SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [p.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /proposals/public/:token/accept error:', err);
    res.status(500).json({ error: 'Failed to accept proposal' });
  }
});

// GET /:token/engagement — get engagement data for signing
router.get('/:token/engagement', async (req, res) => {
  const { token } = req.params;
  try {
    const { rows: prop } = await pool.query(
      'SELECT id, firm_id FROM proposals WHERE public_token = $1',
      [token]
    );
    if (!prop.length) return res.status(404).json({ error: 'Proposal not found' });

    const { rows } = await pool.query(
      'SELECT * FROM proposal_engagements WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1',
      [prop[0].id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No engagement found — please accept the proposal first' });

    const eng = rows[0];
    // Ensure JSONB fields are parsed arrays (pg may return as string in some configs)
    const parseJsonField = (v) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { return JSON.parse(v); } catch(e) { return []; } }
      return v || [];
    };
    eng.tiers = parseJsonField(eng.tiers);
    eng.add_ons = parseJsonField(eng.add_ons);
    eng.backwork = parseJsonField(eng.backwork);
    eng.selected_tier_indices = parseJsonField(eng.selected_tier_indices);

    // Firm details used to fill the engagement letter (name, address, signer).
    const { rows: firmRows } = await pool.query(
      `SELECT COALESCE(NULLIF(f.display_name, ''), f.name) AS name, COALESCE(f.address, '') AS address,
              (SELECT u.name FROM firm_users u WHERE u.firm_id = f.id AND u.role = 'owner' AND u.archived_at IS NULL ORDER BY u.id LIMIT 1) AS owner_name
         FROM firms f WHERE f.id = $1`,
      [prop[0].firm_id]
    );
    eng.firm = firmRows[0] || { name: 'Our firm', address: '', owner_name: '' };

    res.json(eng);
  } catch (err) {
    console.error('GET /proposals/public/:token/engagement error:', err);
    res.status(500).json({ error: 'Failed to fetch engagement' });
  }
});

// POST /:token/sign — submit signature
router.post('/:token/sign', async (req, res) => {
  const { token } = req.params;
  const {
    signerIndex = 0,
    signature_data,
    signed_by_name,
  } = req.body;

  if (!signature_data || !signed_by_name) {
    return res.status(400).json({ error: 'Signature and name required' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  try {
    const { rows: prop } = await pool.query(
      'SELECT id, firm_id, engagement_type FROM proposals WHERE public_token = $1',
      [token]
    );
    if (!prop.length) return res.status(404).json({ error: 'Proposal not found' });

    const { rows: engRows } = await pool.query(
      'SELECT * FROM proposal_engagements WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1',
      [prop[0].id]
    );
    if (!engRows.length) return res.status(404).json({ error: 'Engagement not found' });
    const eng = engRows[0];

    if (eng.status === 'signed') {
      return res.status(409).json({ error: 'Already signed' });
    }

    let updateQuery, updateParams;
    if (signerIndex === 0 || signerIndex === '0') {
      updateQuery = `UPDATE proposal_engagements
        SET signature_data = $1, signed_by_name = $2, signed_at = NOW(), signer_ip = $3, updated_at = NOW()
        WHERE id = $4`;
      updateParams = [signature_data, signed_by_name, ip, eng.id];
    } else {
      updateQuery = `UPDATE proposal_engagements
        SET signature2_data = $1, signed2_by_name = $2, signed2_at = NOW(), signer2_ip = $3, updated_at = NOW()
        WHERE id = $4`;
      updateParams = [signature_data, signed_by_name, ip, eng.id];
    }
    await pool.query(updateQuery, updateParams);

    // Re-fetch to check if all required signers are done
    const { rows: updated } = await pool.query(
      'SELECT * FROM proposal_engagements WHERE id = $1',
      [eng.id]
    );
    const updEng = updated[0];

    const requireDual = updEng.require_dual_signature;
    const signer1Done = !!updEng.signed_by_name && !!updEng.signed_at;
    const signer2Done = !requireDual || (!!updEng.signed2_by_name && !!updEng.signed2_at);
    const allDone = signer1Done && signer2Done;

    if (allDone) {
      await pool.query(
        `UPDATE proposal_engagements SET status = 'signed', updated_at = NOW() WHERE id = $1`,
        [eng.id]
      );
      await pool.query(
        `UPDATE proposals SET status = 'signed', updated_at = NOW() WHERE id = $1`,
        [prop[0].id]
      );

      const appUrl = req.customDomain
        ? 'https://' + req.customDomain
        : (process.env.APP_URL || 'http://localhost:8080');
      setImmediate(() => {
        runSignedProposalAutomation({
          proposalId: prop[0].id,
          firmId: prop[0].firm_id,
          engagementType: prop[0].engagement_type,
          ip,
          appUrl,
        }).catch(e => console.error('[proposals-public] signed proposal automation fatal:', e.message));
      });
    }

    res.json({ ok: true, complete: allDone });
  } catch (err) {
    console.error('POST /proposals/public/:token/sign error:', err);
    res.status(500).json({ error: 'Failed to submit signature' });
  }
});

// GET /:token/pdf — generate and stream a real PDF of the signed engagement letter
router.get('/:token/pdf', async (req, res) => {
  const { token } = req.params;
  try {
    const { rows: prop } = await pool.query(
      'SELECT id, client_name FROM proposals WHERE public_token = $1',
      [token]
    );
    if (!prop.length) return res.status(404).json({ error: 'Not found' });

    const { rows: engRows } = await pool.query(
      'SELECT * FROM proposal_engagements WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1',
      [prop[0].id]
    );
    if (!engRows.length) return res.status(400).json({ error: 'Proposal must be accepted before generating a PDF' });

    const { generatePDF } = require('../services/pdf');

    // Use the live sign page in pdf-only mode so the full LOE + audit trail renders
    // Use custom domain if the request came from one, otherwise fall back to APP_URL
    const appUrl = req.customDomain
      ? 'https://' + req.customDomain
      : (process.env.APP_URL || 'http://localhost:8080');
    const pageUrl = `${appUrl}/p/${token}/sign?pdf=1`;

    const pdfResult = await generatePDF(null, pageUrl);
    // Puppeteer v22+ returns Uint8Array — must convert to Buffer for res.send()
    const pdfBuffer = Buffer.isBuffer(pdfResult) ? pdfResult : Buffer.from(pdfResult);

    const clientName = (prop[0].client_name || 'Engagement-Letter')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${clientName} - Engagement Letter.pdf"`
    );
    res.end(pdfBuffer);
  } catch (err) {
    console.error('[GET /proposals/public/:token/pdf] error:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

// POST /:token/reset — client resets acceptance (go back to package selection)
router.post('/:token/reset', async (req, res) => {
  const { token } = req.params;
  try {
    const { rows: prop } = await pool.query(
      'SELECT id, status FROM proposals WHERE public_token = $1',
      [token]
    );
    if (!prop.length) return res.status(404).json({ error: 'Proposal not found' });

    if (prop[0].status === 'signed') {
      return res.status(409).json({ error: 'Cannot reset a signed proposal' });
    }

    await pool.query('DELETE FROM proposal_acceptances WHERE proposal_id = $1', [prop[0].id]);
    await pool.query('DELETE FROM proposal_engagements WHERE proposal_id = $1', [prop[0].id]);
    await pool.query(
      `UPDATE proposals SET status = 'viewed', accepted_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [prop[0].id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /proposals/public/:token/reset error:', err);
    res.status(500).json({ error: 'Failed to reset proposal' });
  }
});

module.exports = router;
