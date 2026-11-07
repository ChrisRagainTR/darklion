'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { sendPortalNotification } = require('../services/email');
const { formatPersonDisplayName } = require('../utils/displayName');
const { archiveClientMessageCreatedFailClosed } = require('../services/communicationArchive');

const router = Router();

const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

// ── GET /api/bulk-send/filters — data for filter dropdowns ───────────────────
router.get('/filters', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const [relationships, pipelines, templates, filingStatuses, entityTypes, companyStatuses] = await Promise.all([
      pool.query(
        `SELECT id, name, service_tier, billing_status FROM relationships WHERE firm_id = $1 ORDER BY name`,
        [firmId]
      ),
      pool.query(
        `SELECT pi.id, pi.name, pi.tax_year,
           json_agg(json_build_object('id', ps.id, 'name', ps.name, 'position', ps.position) ORDER BY ps.position, ps.id) as stages
         FROM pipeline_instances pi
         JOIN pipeline_stages ps ON ps.template_id = pi.template_id
         WHERE pi.firm_id = $1 AND pi.status = 'active'
         GROUP BY pi.id, pi.name, pi.tax_year
         ORDER BY pi.name`,
        [firmId]
      ),
      pool.query(
        `SELECT id, name, body FROM message_templates WHERE firm_id = $1 ORDER BY name`,
        [firmId]
      ),
      pool.query(
        `SELECT DISTINCT filing_status FROM people
         WHERE firm_id = $1 AND filing_status IS NOT NULL AND filing_status != ''
         ORDER BY filing_status`,
        [firmId]
      ),
      pool.query(
        `SELECT DISTINCT entity_type FROM companies
         WHERE firm_id = $1 AND entity_type IS NOT NULL AND entity_type != ''
         ORDER BY entity_type`,
        [firmId]
      ),
      pool.query(
        `SELECT DISTINCT status FROM companies
         WHERE firm_id = $1 AND status IS NOT NULL AND status != ''
         ORDER BY status`,
        [firmId]
      ),
    ]);

    // Unique service tiers and billing statuses
    const serviceTiers = [...new Set(relationships.rows.map(r => r.service_tier).filter(Boolean))].sort();
    const billingStatuses = [...new Set(relationships.rows.map(r => r.billing_status).filter(Boolean))].sort();

    // Pipeline templates for completion filter
    const pipelineTemplates = await pool.query(
      `SELECT id, name FROM pipeline_templates WHERE firm_id = $1 AND status = 'active' ORDER BY name`,
      [firmId]
    );

    // Distinct tax years from completions
    const completionYears = await pool.query(
      `SELECT DISTINCT tax_year FROM pipeline_completions WHERE firm_id = $1 AND tax_year IS NOT NULL ORDER BY tax_year DESC`,
      [firmId]
    );

    res.json({
      relationships: relationships.rows.map(r => ({ id: r.id, name: r.name })),
      pipelines: pipelines.rows,
      pipelineTemplates: pipelineTemplates.rows,
      completionYears: completionYears.rows.map(r => r.tax_year),
      serviceTiers,
      billingStatuses,
      templates: templates.rows,
      filingStatuses: filingStatuses.rows.map(r => r.filing_status),
      entityTypes: entityTypes.rows.map(r => r.entity_type),
      companyStatuses: companyStatuses.rows.map(r => r.status),
    });
  } catch (err) {
    console.error('[GET /api/bulk-send/filters] error:', err);
    res.status(500).json({ error: 'Failed to load filters' });
  }
});

// ── POST /api/bulk-send/preview — count + list matching recipients ────────────
router.post('/preview', async (req, res) => {
  const firmId = req.firm.id;
  const { filters } = req.body;

  try {
    const { query, params } = buildAudienceQuery(firmId, filters, false);
    const { rows } = await pool.query(query, params);

    res.json({
      count: rows.length,
      recipients: rows.slice(0, 200).map(r => ({
        id: r.id,
        type: r.entity_type,
        name: formatPersonDisplayName(r),
        email: r.email,
        relationship: r.relationship_name,
        companies: r.company_names || null,
      })),
    });
  } catch (err) {
    console.error('[POST /api/bulk-send/preview] error:', err);
    res.status(500).json({ error: 'Failed to build audience preview' });
  }
});

// ── POST /api/bulk-send/send — execute the bulk send ─────────────────────────
router.post('/send', async (req, res) => {
  const firmId = req.firm.id;
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query(
        'SELECT id FROM firm_users WHERE firm_id=$1 AND email=$2 LIMIT 1',
        [firmId, req.firm.email]
      );
      if (rows[0]) userId = rows[0].id;
    } catch (e) { /* silent */ }
  }

  const { subject, message, filters } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message body is required' });
  }

  try {
    // Get firm name for notifications
    const { rows: firmRows } = await pool.query('SELECT name FROM firms WHERE id=$1', [firmId]);
    const firmName = firmRows[0]?.name || 'Your Advisor';

    // Get recipients
    const { query, params } = buildAudienceQuery(firmId, filters, false);
    const { rows: recipients } = await pool.query(query, params);

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipients match the selected filters' });
    }

    // Create bulk_sends record
    const { rows: bsRows } = await pool.query(
      `INSERT INTO bulk_sends (firm_id, subject, message, filter_criteria, recipient_count, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [firmId, subject || '', message.trim(), JSON.stringify(filters || {}), recipients.length, userId]
    );
    const bulkSendId = bsRows[0].id;

    // Send to each person
    const results = [];
    for (const recipient of recipients) {
      if (recipient.entity_type !== 'person') continue; // only people have portal threads
      const personId = recipient.id;

      try {
        // Find or create thread
        const { rows: existingThreads } = await pool.query(
          `SELECT id FROM message_threads
           WHERE firm_id=$1 AND person_id=$2 AND staff_user_id=$3 AND status!='archived'
             AND category IS DISTINCT FROM 'internal'
           LIMIT 1`,
          [firmId, personId, userId]
        );

        let threadId;
        if (existingThreads.length > 0) {
          threadId = existingThreads[0].id;
        } else {
          const { rows: newThread } = await pool.query(
            `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, last_message_at)
             VALUES ($1, $2, $3, $4, 'open', NOW()) RETURNING id`,
            [firmId, personId, userId, subject || 'Message from your advisor']
          );
          threadId = newThread[0].id;
        }

        // Substitute merge tags for this recipient
        const firstName = (recipient.first_name || '').trim() || (recipient.display_name || '').split(' ')[0] || 'there';
        const lastName = (recipient.last_name || '').trim();
        // {Full Name} stays as the taxpayer's individual name (not couple) for merge-tag correctness
        const fullName = `${firstName} ${lastName}`.trim() || recipient.display_name || '';
        const relationshipName = (recipient.relationship_name || '').trim();

        // Build matched company names for {Company Names} tag
        // Find pipeline_stage filters and look up companies in that pipeline for this person's relationship
        let matchedCompanyNames = recipient.company_names || '';
        try {
          const pipelineFilter = (Array.isArray(filters) ? filters : []).find(f => f.type === 'pipeline_stage' && f.value);
          if (pipelineFilter && recipient.relationship_id) {
            const pipeId = Array.isArray(pipelineFilter.value) ? pipelineFilter.value[0] : pipelineFilter.value;
            const stageIds = Array.isArray(pipelineFilter.value2)
              ? pipelineFilter.value2.map(Number).filter(n => !isNaN(n))
              : (pipelineFilter.value2 ? [parseInt(pipelineFilter.value2)].filter(n => !isNaN(n)) : []);
            let matchQuery, matchParams;
            if (stageIds.length) {
              matchQuery = `SELECT c.company_name FROM companies c JOIN pipeline_jobs pj ON pj.entity_id = c.id AND pj.entity_type = 'company' WHERE pj.instance_id = $1 AND pj.current_stage_id = ANY($2::int[]) AND c.relationship_id = $3 ORDER BY c.company_name`;
              matchParams = [pipeId, stageIds, recipient.relationship_id];
            } else {
              matchQuery = `SELECT c.company_name FROM companies c JOIN pipeline_jobs pj ON pj.entity_id = c.id AND pj.entity_type = 'company' WHERE pj.instance_id = $1 AND c.relationship_id = $2 ORDER BY c.company_name`;
              matchParams = [pipeId, recipient.relationship_id];
            }
            const { rows: matchedCos } = await pool.query(matchQuery, matchParams);
            if (matchedCos.length) matchedCompanyNames = matchedCos.map(r => r.company_name).join(', ');
          }
        } catch(e) { /* non-blocking */ }

        const personalizedMessage = message.trim()
          .replace(/\{First Name\}/gi, firstName)
          .replace(/\{Last Name\}/gi, lastName)
          .replace(/\{Full Name\}/gi, fullName)
          .replace(/\{first_name\}/gi, firstName)
          .replace(/\{last_name\}/gi, lastName)
          .replace(/\{Relationship Name\}/gi, relationshipName)
          .replace(/\{relationship_name\}/gi, relationshipName)
          .replace(/\{Firm Name\}/gi, firmName)
          .replace(/\{firm_name\}/gi, firmName)
          .replace(/\{Company Names\}/gi, matchedCompanyNames)
          .replace(/\{company_names\}/gi, matchedCompanyNames)
          .replace(/\{Companies\}/gi, matchedCompanyNames);

        // Insert message
        const { rows: messageRows } = await pool.query(
          `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
           VALUES ($1, 'staff', $2, $3, false)
           RETURNING id`,
          [threadId, userId, personalizedMessage]
        );
        await archiveClientMessageCreatedFailClosed({ firmId, messageId: messageRows[0].id, requestedByStaffUserId: userId });

        // Update last_message_at
        await pool.query(
          'UPDATE message_threads SET last_message_at=NOW() WHERE id=$1',
          [threadId]
        );

        // Record recipient
        await pool.query(
          `INSERT INTO bulk_send_recipients (bulk_send_id, person_id, thread_id)
           VALUES ($1, $2, $3)`,
          [bulkSendId, personId, threadId]
        );

        // Send notification (immediate for bulk sends)
        if (recipient.email) {
          sendPortalNotification({
            to: recipient.email,
            name: formatPersonDisplayName(recipient),
            firmName,
            firmId,
            message: 'You have a new message from your advisor. Log in to view it.',
            portalUrl: APP_URL + '/portal',
          }).catch(e => console.error('[bulk-send] notify error:', e.message));
        }

        results.push({ personId, threadId, ok: true });
      } catch (e) {
        console.error(`[bulk-send] error sending to person ${personId}:`, e.message);
        results.push({ personId, ok: false, error: e.message });
      }
    }

    const sentCount = results.filter(r => r.ok).length;
    res.json({ ok: true, bulkSendId, sentCount, total: recipients.length });
  } catch (err) {
    console.error('[POST /api/bulk-send/send] error:', err);
    res.status(500).json({ error: 'Failed to execute bulk send' });
  }
});

// ── GET /api/bulk-send/history — past bulk sends ─────────────────────────────
router.get('/history', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT bs.id, bs.subject, bs.recipient_count, bs.sent_at,
              fu.name as sent_by_name
       FROM bulk_sends bs
       LEFT JOIN firm_users fu ON fu.id = bs.sent_by
       WHERE bs.firm_id = $1
       ORDER BY bs.sent_at DESC
       LIMIT 50`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/bulk-send/history] error:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// ── Helper: build audience SQL query ─────────────────────────────────────────
// filters: array of { type, value, value2, operator }
//   type: filter type key
//   value: string | string[] (multi-select types) | boolean
//   value2: secondary value (e.g. pipeline stage)
//   operator: 'is' | 'is_not' (default: 'is')
function buildAudienceQuery(firmId, filters = [], countOnly = false) {
  // Support legacy flat-object format (for any callers that still use it)
  if (!Array.isArray(filters)) {
    filters = legacyFiltersToArray(filters);
  }

  const conditions = ['p.firm_id = $1', 'p.portal_enabled = true'];
  const params = [firmId];
  let paramIdx = 2;

  for (const f of filters) {
    const negate = f.operator === 'is_not';
    const val = f.value;
    const val2 = f.value2;
    const isArray = Array.isArray(val) && val.length > 0;
    const isEmpty = !val || (Array.isArray(val) && val.length === 0);

    switch (f.type) {
      case 'relationship': {
        if (!val) break;
        const rid = parseInt(val);
        if (isNaN(rid)) break;
        const cond = `p.relationship_id = $${paramIdx++}`;
        conditions.push(negate ? `NOT (${cond})` : cond);
        params.push(rid);
        break;
      }

      case 'service_tier': {
        if (isEmpty) break;
        if (isArray) {
          const cond = `r.service_tier = ANY($${paramIdx++}::text[])`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        } else {
          const cond = `r.service_tier = $${paramIdx++}`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        }
        break;
      }

      case 'billing_status': {
        if (isEmpty) break;
        if (isArray) {
          const cond = `r.billing_status = ANY($${paramIdx++}::text[])`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        } else {
          const cond = `r.billing_status = $${paramIdx++}`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        }
        break;
      }

      case 'filing_status': {
        if (isEmpty) break;
        if (isArray) {
          const cond = `p.filing_status = ANY($${paramIdx++}::text[])`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        } else {
          const cond = `p.filing_status = $${paramIdx++}`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        }
        break;
      }

      case 'entity_type': {
        if (isEmpty) break;
        const vals = isArray ? val : [val];
        const hasIndividual = vals.includes('individual');
        const otherVals = vals.filter(v => v !== 'individual');

        if (vals.length === 1 && hasIndividual) {
          // Only "individual" selected
          const cond = `NOT EXISTS (SELECT 1 FROM person_company_access pca WHERE pca.person_id = p.id)`;
          conditions.push(negate ? `NOT (${cond})` : cond);
        } else if (otherVals.length > 0 && !hasIndividual) {
          const cond = `EXISTS (
            SELECT 1 FROM person_company_access pca
            JOIN companies co ON co.id = pca.company_id
            WHERE pca.person_id = p.id AND co.entity_type = ANY($${paramIdx++}::text[])
          )`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(otherVals);
        } else if (otherVals.length > 0 && hasIndividual) {
          // Either no company or company with one of the types
          const cond = `(
            NOT EXISTS (SELECT 1 FROM person_company_access pca WHERE pca.person_id = p.id)
            OR EXISTS (
              SELECT 1 FROM person_company_access pca
              JOIN companies co ON co.id = pca.company_id
              WHERE pca.person_id = p.id AND co.entity_type = ANY($${paramIdx++}::text[])
            )
          )`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(otherVals);
        }
        break;
      }

      case 'company_status': {
        if (isEmpty) break;
        if (isArray) {
          const cond = `EXISTS (
            SELECT 1 FROM person_company_access pca
            JOIN companies co ON co.id = pca.company_id
            WHERE pca.person_id = p.id
              AND co.status = ANY($${paramIdx++}::text[])
              AND co.firm_id = $1
          )`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        } else {
          const cond = `EXISTS (
            SELECT 1 FROM person_company_access pca
            JOIN companies co ON co.id = pca.company_id
            WHERE pca.person_id = p.id
              AND co.status = $${paramIdx++}
              AND co.firm_id = $1
          )`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        }
        break;
      }

      case 'portal_activity': {
        if (!val) break;
        if (val === 'never' || (isArray && val.includes('never'))) {
          const cond = `p.portal_last_login_at IS NULL`;
          conditions.push(negate ? `NOT (${cond})` : cond);
        } else {
          const dayVal = isArray ? val[0] : val;
          const days = parseInt(dayVal);
          if (!isNaN(days)) {
            const cond = `p.portal_last_login_at > NOW() - INTERVAL '${days} days'`;
            conditions.push(negate ? `NOT (${cond})` : cond);
          }
        }
        break;
      }

      case 'pipeline_stage': {
        if (!val) break;
        const pipeId = parseInt(isArray ? val[0] : val);
        if (isNaN(pipeId)) break;
        // value2 can be a single id, array of ids, or empty (any stage)
        const stageIds = Array.isArray(val2)
          ? val2.map(Number).filter(n => !isNaN(n))
          : (val2 ? [parseInt(val2)].filter(n => !isNaN(n)) : []);
        let cond;
        if (!stageIds.length) {
          // Any stage — match people directly OR people in same relationship as a company in this pipeline
          cond = `(
            EXISTS (
              SELECT 1 FROM pipeline_jobs pj
              WHERE pj.instance_id = $${paramIdx++}
                AND pj.entity_type = 'person'
                AND pj.entity_id = p.id
            )
            OR EXISTS (
              SELECT 1 FROM pipeline_jobs pj
              JOIN companies c ON c.id = pj.entity_id AND pj.entity_type = 'company'
              WHERE pj.instance_id = $${paramIdx++}
                AND c.relationship_id = p.relationship_id
            )
          )`;
          params.push(pipeId, pipeId);
        } else {
          cond = `(
            EXISTS (
              SELECT 1 FROM pipeline_jobs pj
              WHERE pj.instance_id = $${paramIdx++}
                AND pj.current_stage_id = ANY($${paramIdx++}::int[])
                AND pj.entity_type = 'person'
                AND pj.entity_id = p.id
            )
            OR EXISTS (
              SELECT 1 FROM pipeline_jobs pj
              JOIN companies c ON c.id = pj.entity_id AND pj.entity_type = 'company'
              WHERE pj.instance_id = $${paramIdx++}
                AND pj.current_stage_id = ANY($${paramIdx++}::int[])
                AND c.relationship_id = p.relationship_id
            )
          )`;
          params.push(pipeId, stageIds, pipeId, stageIds);
        }
        conditions.push(negate ? `NOT (${cond})` : cond);
        break;
      }

      case 'proposal_status': {
        if (isEmpty) break;
        if (isArray) {
          const cond = `EXISTS (
            SELECT 1 FROM proposals prop
            WHERE prop.firm_id = $1
              AND prop.relationship_id = p.relationship_id
              AND prop.status = ANY($${paramIdx++}::text[])
          )`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        } else {
          const cond = `EXISTS (
            SELECT 1 FROM proposals prop
            WHERE prop.firm_id = $1
              AND prop.relationship_id = p.relationship_id
              AND prop.status = $${paramIdx++}
          )`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(val);
        }
        break;
      }

      case 'has_documents': {
        const cond = `EXISTS (
          SELECT 1 FROM documents d
          WHERE d.owner_type = 'person'
            AND d.owner_id = p.id
            AND d.firm_id = $1
        )`;
        conditions.push(negate ? `NOT (${cond})` : cond);
        break;
      }

      case 'pipeline_completed': {
        // val = pipeline template id (required), val2 = tax year (optional, 'any' or year number)
        if (!val) break;
        const templateId = parseInt(isArray ? val[0] : val);
        if (isNaN(templateId)) break;
        const yearVal = val2 && val2 !== 'any' ? parseInt(val2) : null;

        if (yearVal) {
          const cond = `EXISTS (
            SELECT 1 FROM pipeline_completions pc
            JOIN pipeline_instances pi ON pi.id = pc.pipeline_instance_id
            WHERE pc.firm_id = $1
              AND pc.entity_type = 'person'
              AND pc.entity_id = p.id
              AND pi.template_id = $${paramIdx++}
              AND pc.tax_year = $${paramIdx++}
          )`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(templateId);
          params.push(yearVal);
        } else {
          const cond = `EXISTS (
            SELECT 1 FROM pipeline_completions pc
            JOIN pipeline_instances pi ON pi.id = pc.pipeline_instance_id
            WHERE pc.firm_id = $1
              AND pc.entity_type = 'person'
              AND pc.entity_id = p.id
              AND pi.template_id = $${paramIdx++}
          )`;
          conditions.push(negate ? `NOT (${cond})` : cond);
          params.push(templateId);
        }
        break;
      }

      default:
        break;
    }
  }

  const whereClause = conditions.join(' AND ');

  const query = `
    SELECT
      p.id,
      'person' AS entity_type,
      p.first_name,
      p.last_name,
      p.spouse_name,
      p.relationship_id,
      (p.first_name || ' ' || p.last_name) AS display_name,
      p.email,
      r.name AS relationship_name,
      (SELECT string_agg(c.company_name, ', ' ORDER BY c.company_name)
       FROM companies c WHERE c.relationship_id = r.id AND c.firm_id = p.firm_id) AS company_names
    FROM people p
    LEFT JOIN relationships r ON r.id = p.relationship_id
    WHERE ${whereClause}
    ORDER BY p.last_name, p.first_name
  `;

  return { query, params };
}

// Convert legacy flat-object filters to new array format
function legacyFiltersToArray(filters) {
  const arr = [];
  if (filters.relationship_id) arr.push({ type: 'relationship', value: filters.relationship_id, operator: 'is' });
  if (filters.service_tier) arr.push({ type: 'service_tier', value: filters.service_tier, operator: 'is' });
  if (filters.billing_status) arr.push({ type: 'billing_status', value: filters.billing_status, operator: 'is' });
  if (filters.entity_type) arr.push({ type: 'entity_type', value: filters.entity_type, operator: 'is' });
  if (filters.filing_status) arr.push({ type: 'filing_status', value: filters.filing_status, operator: 'is' });
  if (filters.company_status) arr.push({ type: 'company_status', value: filters.company_status, operator: 'is' });
  if (filters.has_documents) arr.push({ type: 'has_documents', value: true, operator: 'is' });
  if (filters.portal_never_logged_in) arr.push({ type: 'portal_activity', value: 'never', operator: 'is' });
  else if (filters.portal_active_days) arr.push({ type: 'portal_activity', value: filters.portal_active_days, operator: 'is' });
  if (filters.pipeline_instance_id && filters.pipeline_stage_id) {
    arr.push({ type: 'pipeline_stage', value: filters.pipeline_instance_id, value2: filters.pipeline_stage_id, operator: 'is' });
  }
  if (filters.proposal_status) arr.push({ type: 'proposal_status', value: filters.proposal_status, operator: 'is' });
  return arr;
}

module.exports = router;
