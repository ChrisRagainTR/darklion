'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { getSignedDownloadUrl } = require('../services/s3');
const { sendEmail, sendPortalNotification } = require('../services/email');
const { sendClientMobilePush } = require('../services/mobilePush');
const { fireTrigger } = require('../services/pipelineTriggers');
const { recordActivityEvent } = require('../services/activityLog');
const { archiveClientMessageCreatedFailClosed } = require('../services/communicationArchive');

const router = Router();

// ── Helper: compute overall delivery status from signers ──────────────────
function computeDeliveryStatus(signers, currentStatus) {
  if (currentStatus === 'draft') return 'draft';
  if (currentStatus === 'complete') return 'complete';
  if (signers.length === 0) return currentStatus;

  const anyNeedsChanges = signers.some(s => s.needs_changes_at);
  if (anyNeedsChanges) return 'needs_changes';

  const allSigned = signers.every(s => s.signed_at);
  if (allSigned) return 'signed';

  const allApproved = signers.every(s => s.approved_at);
  if (allApproved && !signers.some(s => s.signed_at)) return 'approved';

  return 'sent';
}

// ── Helper: advance pipeline job to next stage ────────────────────────────
async function advancePipelineJob(jobId) {
  try {
    const { rows: jobRows } = await pool.query('SELECT * FROM pipeline_jobs WHERE id = $1', [jobId]);
    if (!jobRows[0]) return;
    const job = jobRows[0];

    const { rows: stages } = await pool.query(
      `SELECT ps.* FROM pipeline_stages ps
       JOIN pipeline_instances pi ON pi.template_id = ps.template_id
       JOIN pipeline_jobs pj ON pj.instance_id = pi.id
       WHERE pj.id = $1
       ORDER BY ps.position ASC`,
      [jobId]
    );

    const currentIdx = stages.findIndex(s => s.id === job.current_stage_id);
    if (currentIdx >= 0 && currentIdx < stages.length - 1) {
      const nextStage = stages[currentIdx + 1];
      await pool.query(
        'UPDATE pipeline_jobs SET current_stage_id = $1, updated_at = NOW() WHERE id = $2',
        [nextStage.id, jobId]
      );
      await pool.query(
        'INSERT INTO pipeline_job_history (job_id, from_stage_id, to_stage_id, moved_by, note) VALUES ($1, $2, $3, $4, $5)',
        [jobId, job.current_stage_id, nextStage.id, null, 'Auto-advanced on e-sign completion']
      );
    }
  } catch (err) {
    console.error('[tax-delivery] advancePipelineJob error:', err);
  }
}

// ── GET /tax-deliveries?company_id=X or ?person_id=X ─────────────────────
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const { company_id, person_id } = req.query;

  try {
    let query = `
      SELECT td.*, co.company_name,
        (SELECT json_agg(row_to_json(s)) FROM (
          SELECT tds.person_id, p.first_name || ' ' || p.last_name AS person_name,
                 tds.approved_at, tds.signed_at, tds.needs_changes_at, tds.signed_doc_id
          FROM tax_delivery_signers tds
          JOIN people p ON p.id = tds.person_id
          WHERE tds.delivery_id = td.id
        ) s) AS signers
      FROM tax_deliveries td
      LEFT JOIN companies co ON co.id = td.company_id
      WHERE td.firm_id = $1
    `;
    const params = [firmId];

    if (company_id) {
      params.push(parseInt(company_id));
      query += ` AND td.company_id = $${params.length}`;
    } else if (person_id) {
      // Return deliveries for all companies this person is linked to (as signer or via company access)
      params.push(parseInt(person_id));
      query += ` AND (
        td.id IN (SELECT delivery_id FROM tax_delivery_signers WHERE person_id = $${params.length})
        OR td.company_id IN (
          SELECT company_id FROM person_company_access WHERE person_id = $${params.length}
        )
      )`;
    }

    query += ' ORDER BY td.created_at DESC';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('[tax-delivery] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch deliveries' });
  }
});

// ── POST /tax-deliveries ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const {
    company_id, person_id, tax_year, title, intro_note, tax_summary,
    review_doc_id, signature_doc_id, signer_person_ids = [], pipeline_job_id,
    include_spouse = true  // default true; pass false to suppress spouse auto-add
  } = req.body;

  if (!tax_year) {
    return res.status(400).json({ error: 'tax_year is required' });
  }
  if (!company_id && !person_id) {
    return res.status(400).json({ error: 'company_id or person_id is required' });
  }

  try {
    // Verify company belongs to firm (if company delivery)
    if (company_id) {
      const { rows: co } = await pool.query(
        'SELECT id FROM companies WHERE id = $1 AND firm_id = $2', [company_id, firmId]
      );
      if (!co[0]) return res.status(404).json({ error: 'Company not found' });
    }

    // Verify person belongs to firm (if personal delivery)
    if (person_id && !company_id) {
      const { rows: pe } = await pool.query(
        'SELECT id FROM people WHERE id = $1 AND firm_id = $2', [person_id, firmId]
      );
      if (!pe[0]) return res.status(404).json({ error: 'Person not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO tax_deliveries
         (firm_id, company_id, tax_year, title, intro_note, tax_summary, review_doc_id, signature_doc_id, pipeline_job_id, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
       RETURNING *`,
      [firmId, company_id || null, tax_year, title || '', intro_note || '',
       JSON.stringify(tax_summary || {}), review_doc_id || null, signature_doc_id || null,
       pipeline_job_id || null, userId || null]
    );
    const delivery = rows[0];

    // Add signers — always include person_id for personal returns
    const allSigners = [...new Set([
      ...(person_id ? [parseInt(person_id)] : []),
      ...signer_person_ids.map(p => parseInt(p)),
    ])];
    for (const pid of allSigners) {
      await pool.query(
        'INSERT INTO tax_delivery_signers (delivery_id, person_id, signer_role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [delivery.id, pid, 'taxpayer']
      );
    }

    // Auto-add spouse signer for MFJ with active spouse portal (unless advisor explicitly unchecked spouse)
    if (!include_spouse) { /* skip spouse auto-add */ } else
    for (const pid of allSigners) {
      const { rows: [person] } = await pool.query(
        'SELECT filing_status, spouse_portal_enabled, spouse_email FROM people WHERE id = $1',
        [parseInt(pid)]
      );
      if (person && ['mfj','mfs'].includes(person.filing_status) && person.spouse_portal_enabled && person.spouse_email) {
        await pool.query(
          'INSERT INTO tax_delivery_signers (delivery_id, person_id, signer_role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [delivery.id, parseInt(pid), 'spouse']
        );
      }
    }

    res.status(201).json(delivery);
  } catch (err) {
    console.error('[tax-delivery] POST / error:', err);
    res.status(500).json({ error: 'Failed to create delivery' });
  }
});

// ── GET /tax-deliveries/:id ───────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT td.*, co.company_name,
         (SELECT json_agg(row_to_json(x)) FROM (
           SELECT tds.id, tds.person_id, tds.approved_at, tds.approved_ip,
                  tds.signed_at, tds.signed_ip, tds.signature_type,
                  tds.needs_changes_at, tds.needs_changes_note,
                  tds.signed_doc_id,
                  p.first_name, p.last_name, p.email,
                  p.first_name || ' ' || p.last_name AS person_name
           FROM tax_delivery_signers tds
           JOIN people p ON p.id = tds.person_id
           WHERE tds.delivery_id = td.id
         ) x) AS signers,
         rd.display_name AS review_doc_name,
         sd.display_name AS signature_doc_name
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       LEFT JOIN documents rd ON rd.id = td.review_doc_id
       LEFT JOIN documents sd ON sd.id = td.signature_doc_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tax-delivery] GET /:id error:', err);
    res.status(500).json({ error: 'Failed to fetch delivery' });
  }
});

// ── PUT /tax-deliveries/:id ───────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  const {
    title, intro_note, tax_summary, review_doc_id, signature_doc_id, signer_person_ids
  } = req.body;

  try {
    const { rows: existing } = await pool.query(
      'SELECT id, status FROM tax_deliveries WHERE id = $1 AND firm_id = $2', [id, firmId]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (existing[0].status !== 'draft') return res.status(400).json({ error: 'Only draft deliveries can be edited' });

    await pool.query(
      `UPDATE tax_deliveries SET
         title = COALESCE($1, title),
         intro_note = COALESCE($2, intro_note),
         tax_summary = COALESCE($3, tax_summary),
         review_doc_id = COALESCE($4, review_doc_id),
         signature_doc_id = COALESCE($5, signature_doc_id),
         updated_at = NOW()
       WHERE id = $6 AND firm_id = $7`,
      [title, intro_note, tax_summary ? JSON.stringify(tax_summary) : null,
       review_doc_id || null, signature_doc_id || null, id, firmId]
    );

    if (Array.isArray(signer_person_ids)) {
      await pool.query('DELETE FROM tax_delivery_signers WHERE delivery_id = $1', [id]);
      for (const pid of signer_person_ids) {
        await pool.query(
          'INSERT INTO tax_delivery_signers (delivery_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, pid]
        );
      }
    }

    const { rows } = await pool.query('SELECT * FROM tax_deliveries WHERE id = $1', [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('[tax-delivery] PUT /:id error:', err);
    res.status(500).json({ error: 'Failed to update delivery' });
  }
});

// ── POST /tax-deliveries/:id/send ─────────────────────────────────────────
router.post('/:id/send', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows: existing } = await pool.query(
      `SELECT td.*, co.company_name, f.name AS firm_name
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       JOIN firms f ON f.id = td.firm_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (existing[0].status !== 'draft') return res.status(400).json({ error: 'Only draft deliveries can be sent' });

    const delivery = existing[0];

    await pool.query(
      "UPDATE tax_deliveries SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1",
      [id]
    );

    // Mark attached docs as delivered so they appear in client portal
    if (delivery.review_doc_id) {
      await pool.query(
        "UPDATE documents SET is_delivered = true, delivered_at = NOW() WHERE id = $1",
        [delivery.review_doc_id]
      );
    }
    if (delivery.signature_doc_id) {
      await pool.query(
        "UPDATE documents SET is_delivered = true, delivered_at = NOW() WHERE id = $1",
        [delivery.signature_doc_id]
      );
    }

    // Fetch signers with their person info
    const { rows: signers } = await pool.query(
      `SELECT tds.person_id, tds.signer_role, p.first_name, p.last_name, p.email, p.spouse_name, p.spouse_email, p.firm_id
       FROM tax_delivery_signers tds
       JOIN people p ON p.id = tds.person_id
       WHERE tds.delivery_id = $1 AND p.firm_id = $2`,
      [id, firmId]
    );

    const portalUrl = process.env.PORTAL_URL || (process.env.APP_URL || 'http://localhost:8080') + '/portal';
    // The staff member sending the return owns the client conversation, so replies land in their inbox.
    const ownerStaffId = req.firm.userId || delivery.created_by || null;
    const notifiedPeople = new Set();

    for (const signer of signers) {
      // Spouse signer rows share the primary's person record; email the spouse at their own address.
      const isSpouse = signer.signer_role === 'spouse';
      const to = isSpouse ? signer.spouse_email : signer.email;
      const fullName = isSpouse ? (signer.spouse_name || '') : `${signer.first_name || ''} ${signer.last_name || ''}`.trim();

      // Send portal notification email
      if (to) {
        try {
          await sendPortalNotification({
            to,
            name: fullName,
            firmName: delivery.firm_name,
            firmId: signer.firm_id,
            message: `Your ${delivery.tax_year} tax return from ${delivery.firm_name} is ready for your review. Log in to your portal to review and sign.`,
            portalUrl,
          });
        } catch (emailErr) {
          console.error('[tax-delivery] send notification email error:', emailErr);
        }
      }

      // Push and intro note go once per person record (MFJ spouses share it).
      if (notifiedPeople.has(signer.person_id)) continue;
      notifiedPeople.add(signer.person_id);

      setImmediate(() => {
        sendClientMobilePush({
          firmId,
          personId: signer.person_id,
          type: 'tax_delivery',
          title: 'Tax return ready',
          body: `Your ${delivery.tax_year} tax return is ready to review and sign.`,
          data: { deliveryId: id },
        });
      });

      // Post the intro note into the sender's regular conversation with this client
      // (never an internal Tasks thread), so the client's reply shows up in the inbox.
      try {
        if (delivery.intro_note) {
          let threadId = null;
          if (ownerStaffId) {
            const { rows: existingThread } = await pool.query(
              `SELECT id FROM message_threads
               WHERE firm_id = $1 AND person_id = $2 AND staff_user_id = $3
                 AND category IS DISTINCT FROM 'internal'
               ORDER BY last_message_at DESC NULLS LAST
               LIMIT 1`,
              [firmId, signer.person_id, ownerStaffId]
            );
            threadId = existingThread[0]?.id || null;
          }
          if (threadId) {
            await pool.query(
              `UPDATE message_threads SET status = 'open', staff_archived_at = NULL, last_message_at = NOW() WHERE id = $1 AND firm_id = $2`,
              [threadId, firmId]
            );
          } else {
            const { rows: threadRows } = await pool.query(
              `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, category, last_message_at)
               VALUES ($1, $2, $3, $4, 'open', 'tax', NOW())
               RETURNING id`,
              [firmId, signer.person_id, ownerStaffId, `${delivery.tax_year} Tax Return — Ready for Review`]
            );
            threadId = threadRows[0]?.id || null;
          }
          if (threadId) {
            const { rows: messageRows } = await pool.query(
              `INSERT INTO messages (thread_id, sender_type, sender_id, body)
               VALUES ($1, 'staff', $2, $3)
               RETURNING id`,
              [threadId, req.firm.userId || ownerStaffId || 0, delivery.intro_note]
            );
            await archiveClientMessageCreatedFailClosed({ firmId, messageId: messageRows[0].id, requestedByStaffUserId: req.firm.userId || null });
          }
        }
      } catch (msgErr) {
        console.error('[tax-delivery] create message thread error:', msgErr);
      }
    }

    // Fire smart pipeline trigger — personal delivery fires once on the primary person only
    // (never fires on company for personal returns; deduplicate to avoid double-cards for MFJ)
    const triggerCtx = { delivery_id: id, tax_year: delivery.tax_year, triggered_by_user_id: req.firm.userId || null };
    if (delivery.company_id) {
      recordActivityEvent({
        firmId,
        eventType: 'tax_return_deployed',
        title: `${delivery.tax_year} tax return sent to client`,
        summary: `${delivery.tax_year} tax return was sent for ${delivery.company_name || 'company #' + delivery.company_id}.`,
        companyId: delivery.company_id,
        taxYear: delivery.tax_year,
        entityType: 'company',
        entityId: delivery.company_id,
        sourceTable: 'tax_deliveries',
        sourceId: String(id),
        dedupeKey: `tax_return_deployed:${id}:company:${delivery.company_id}`,
        metadata: { delivery_id: id, company_id: delivery.company_id },
      });
      fireTrigger(firmId, 'tax_return_deployed', delivery.company_id, triggerCtx, 'company').catch(e => console.error('[tax-delivery] fireTrigger non-fatal:', e));
    } else {
      // Fire only once — use the taxpayer signer row (signer_role='taxpayer'), not spouse
      const primarySigner = signers.find(s => s.signer_role === 'taxpayer') || signers[0];
      if (primarySigner) {
        const signerName = `${primarySigner.first_name || ''} ${primarySigner.last_name || ''}`.trim();
        recordActivityEvent({
          firmId,
          eventType: 'tax_return_deployed',
          title: `${delivery.tax_year} tax return sent to client`,
          summary: `${delivery.tax_year} tax return was sent to ${signerName || 'client'}.`,
          personId: primarySigner.person_id,
          taxYear: delivery.tax_year,
          entityType: 'person',
          entityId: primarySigner.person_id,
          sourceTable: 'tax_deliveries',
          sourceId: String(id),
          dedupeKey: `tax_return_deployed:${id}:person:${primarySigner.person_id}`,
          metadata: { delivery_id: id, person_id: primarySigner.person_id },
        });
        fireTrigger(firmId, 'tax_return_deployed', primarySigner.person_id, triggerCtx, 'person').catch(e => console.error('[tax-delivery] fireTrigger non-fatal:', e));
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[tax-delivery] POST /:id/send error:', err);
    res.status(500).json({ error: 'Failed to send delivery' });
  }
});

// ── POST /tax-deliveries/:id/efile  { status: 'filed' | 'accepted' | 'not_filed' } ──
// Records e-file progress for a fully signed return so the client can see it was filed and accepted.
router.post('/:id/efile', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  const status = String(req.body?.status || '');
  if (!['filed', 'accepted', 'not_filed'].includes(status)) {
    return res.status(400).json({ error: "status must be 'filed', 'accepted', or 'not_filed'" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT td.*, co.company_name FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    const delivery = rows[0];
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    if (!['signed', 'complete'].includes(delivery.status)) {
      return res.status(400).json({ error: 'A return can be marked filed only after every signer has signed' });
    }

    const sql = status === 'not_filed'
      ? 'UPDATE tax_deliveries SET filed_at = NULL, accepted_at = NULL, filed_date_known = TRUE, updated_at = NOW() WHERE id = $1 RETURNING filed_at, accepted_at'
      : status === 'filed'
        ? 'UPDATE tax_deliveries SET filed_date_known = CASE WHEN filed_at IS NULL THEN TRUE ELSE filed_date_known END, filed_at = COALESCE(filed_at, NOW()), accepted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING filed_at, accepted_at'
        : 'UPDATE tax_deliveries SET filed_date_known = CASE WHEN filed_at IS NULL THEN TRUE ELSE filed_date_known END, filed_at = COALESCE(filed_at, NOW()), accepted_at = COALESCE(accepted_at, NOW()), updated_at = NOW() WHERE id = $1 RETURNING filed_at, accepted_at';
    const { rows: updated } = await pool.query(sql, [id]);
    const newlyAccepted = status === 'accepted' && !delivery.accepted_at;

    if (status !== 'not_filed') {
      const { rows: signers } = await pool.query(
        `SELECT person_id, signer_role FROM tax_delivery_signers WHERE delivery_id = $1
         ORDER BY CASE WHEN signer_role = 'taxpayer' THEN 0 ELSE 1 END`,
        [id]
      );
      const primary = signers[0];
      recordActivityEvent({
        firmId,
        eventType: status === 'accepted' ? 'tax_return_accepted' : 'tax_return_filed',
        title: `${delivery.tax_year} tax return ${status === 'accepted' ? 'accepted' : 'e-filed'}`,
        summary: `${delivery.tax_year} tax return ${status === 'accepted' ? 'was accepted' : 'was e-filed'}${delivery.company_name ? ' for ' + delivery.company_name : ''}.`,
        personId: primary?.person_id || null,
        companyId: delivery.company_id || null,
        taxYear: delivery.tax_year,
        entityType: delivery.company_id ? 'company' : 'person',
        entityId: delivery.company_id || primary?.person_id || null,
        sourceTable: 'tax_deliveries',
        sourceId: String(id),
        dedupeKey: `tax_return_${status}:${id}`,
        metadata: { delivery_id: id, triggered_by_user_id: req.firm.userId || null },
      });
      if (newlyAccepted) {
        const notified = new Set();
        for (const signer of signers) {
          if (notified.has(signer.person_id)) continue;
          notified.add(signer.person_id);
          setImmediate(() => sendClientMobilePush({
            firmId,
            personId: signer.person_id,
            type: 'tax_delivery',
            title: 'Tax return accepted',
            body: `Your ${delivery.tax_year} tax return${delivery.company_name ? ' for ' + delivery.company_name : ''} was accepted.`,
            data: { deliveryId: id },
          }));
        }
      }
    }

    res.json({ ok: true, filed_at: updated[0].filed_at, accepted_at: updated[0].accepted_at });
  } catch (err) {
    console.error('[tax-delivery] POST /:id/efile error:', err);
    res.status(500).json({ error: 'Failed to update e-file status' });
  }
});

// ── POST /tax-deliveries/:id/remind ─────────────────────────────────────
// Staff reminder to signers who have not signed yet: portal email plus an app notification.
// Limited to one reminder every REMIND_COOLDOWN_HOURS so a double click cannot send twice.
router.post('/:id/remind', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  const { REMIND_COOLDOWN_HOURS } = require('../services/advisorToday');
  try {
    const { rows } = await pool.query(
      `UPDATE tax_deliveries SET last_reminded_at = NOW()
       WHERE id = $1 AND firm_id = $2 AND status IN ('sent', 'approved')
         AND (last_reminded_at IS NULL OR last_reminded_at < NOW() - make_interval(hours => $3))
       RETURNING id, tax_year, company_id`,
      [id, firmId, REMIND_COOLDOWN_HOURS]
    );
    if (!rows[0]) {
      const { rows: cur } = await pool.query('SELECT status, last_reminded_at FROM tax_deliveries WHERE id = $1 AND firm_id = $2', [id, firmId]);
      if (!cur[0]) return res.status(404).json({ error: 'Delivery not found' });
      if (!['sent', 'approved'].includes(cur[0].status)) return res.status(400).json({ error: 'Only returns waiting on signatures can be reminded' });
      return res.status(429).json({ error: 'A reminder already went out recently', last_reminded_at: cur[0].last_reminded_at });
    }
    const delivery = rows[0];
    const { rows: signers } = await pool.query(
      `SELECT s.person_id, s.signer_role, p.first_name, p.last_name, p.email, p.spouse_name, p.spouse_email, f.name AS firm_name
       FROM tax_delivery_signers s JOIN people p ON p.id = s.person_id JOIN firms f ON f.id = $2
       WHERE s.delivery_id = $1 AND s.signed_at IS NULL`,
      [id, firmId]
    );
    const portalUrl = process.env.PORTAL_URL || (process.env.APP_URL || 'http://localhost:8080') + '/portal';
    let emailed = 0;
    const pushed = new Set();
    for (const s of signers) {
      const isSpouse = s.signer_role === 'spouse';
      const to = isSpouse ? s.spouse_email : s.email;
      const name = isSpouse ? (s.spouse_name || '') : `${s.first_name || ''} ${s.last_name || ''}`.trim();
      if (to) {
        try {
          await sendPortalNotification({
            to, name, firmName: s.firm_name, firmId,
            message: `Reminder: your ${delivery.tax_year} tax return from ${s.firm_name} is waiting for your review and signature. Log in to your portal to review and sign.`,
            portalUrl,
          });
          emailed++;
        } catch (e) { console.error('[tax-delivery] remind email error:', e.message); }
      }
      if (!pushed.has(s.person_id)) {
        pushed.add(s.person_id);
        setImmediate(() => sendClientMobilePush({
          firmId, personId: s.person_id, type: 'tax_delivery',
          title: 'Tax return waiting for you',
          body: `Your ${delivery.tax_year} tax return is ready to review and sign.`,
          data: { deliveryId: id },
        }));
      }
    }
    recordActivityEvent({
      firmId,
      eventType: 'tax_return_reminder_sent',
      title: `${delivery.tax_year} tax return reminder sent`,
      summary: `Signature reminder sent to ${signers.length} signer${signers.length === 1 ? '' : 's'}.`,
      companyId: delivery.company_id || null,
      personId: signers[0] ? signers[0].person_id : null,
      taxYear: delivery.tax_year,
      entityType: delivery.company_id ? 'company' : 'person',
      entityId: delivery.company_id || (signers[0] ? signers[0].person_id : null),
      sourceTable: 'tax_deliveries',
      sourceId: String(id),
      dedupeKey: `tax_return_reminder:${id}:${new Date().toISOString().slice(0, 13)}`,
      metadata: { delivery_id: id, triggered_by_user_id: req.firm.userId || null, emailed },
    });
    res.json({ ok: true, signers: signers.length, emailed });
  } catch (err) {
    console.error('[tax-delivery] POST /:id/remind error:', err);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// ── DELETE /tax-deliveries/:id ────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      'SELECT id, status FROM tax_deliveries WHERE id = $1 AND firm_id = $2', [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft deliveries can be deleted' });

    await pool.query('DELETE FROM tax_deliveries WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[tax-delivery] DELETE /:id error:', err);
    res.status(500).json({ error: 'Failed to delete delivery' });
  }
});

// ── POST /tax-deliveries/:id/cancel ──────────────────────────────────────
// (consolidated: keeps runtime behavior while restoring full rollback of attached portal docs/signatures)
router.post('/:id/cancel', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      'SELECT id, status FROM tax_deliveries WHERE id = $1 AND firm_id = $2', [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (!['sent', 'needs_changes', 'approved'].includes(rows[0].status)) {
      return res.status(400).json({ error: 'Cannot cancel a delivery in this state' });
    }

    const { rows: cancelRows } = await pool.query(
      'SELECT review_doc_id, signature_doc_id FROM tax_deliveries WHERE id = $1',
      [id]
    );

    // Reset signer fields
    await pool.query(
      `UPDATE tax_delivery_signers SET
         approved_at = NULL, approved_ip = '',
         signed_at = NULL, signed_ip = '', signature_data = '',
         needs_changes_at = NULL, needs_changes_note = ''
       WHERE delivery_id = $1`,
      [id]
    );

    await pool.query(
      "UPDATE tax_deliveries SET status = 'draft', needs_changes_note = '', updated_at = NOW() WHERE id = $1",
      [id]
    );

    // Un-deliver attached docs so they disappear from the client portal until resent
    const cancelDel = cancelRows[0];
    if (cancelDel?.review_doc_id) await pool.query("UPDATE documents SET is_delivered = false WHERE id = $1", [cancelDel.review_doc_id]);
    if (cancelDel?.signature_doc_id) await pool.query("UPDATE documents SET is_delivered = false WHERE id = $1", [cancelDel.signature_doc_id]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[tax-delivery] POST /:id/cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel delivery' });
  }
});

// ── GET /tax-deliveries/:id/download-review ───────────────────────────────
router.get('/:id/download-review', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT td.review_doc_id, d.s3_key, d.s3_bucket
       FROM tax_deliveries td
       JOIN documents d ON d.id = td.review_doc_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Review document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[tax-delivery] GET /:id/download-review error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ── GET /tax-deliveries/:id/download-signature ────────────────────────────
router.get('/:id/download-signature', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT td.signature_doc_id, d.s3_key, d.s3_bucket
       FROM tax_deliveries td
       JOIN documents d ON d.id = td.signature_doc_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Signature document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[tax-delivery] GET /:id/download-signature error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ── POST /tax-deliveries/:id/generate-summary ────────────────────────────
router.post('/:id/generate-summary', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT td.*, d.s3_key, d.s3_bucket
       FROM tax_deliveries td
       LEFT JOIN documents d ON d.id = td.review_doc_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    const delivery = rows[0];
    if (!delivery.s3_key) return res.status(400).json({ error: 'No review document attached' });

    await pool.query(
      "UPDATE tax_deliveries SET tax_report_status = 'processing', tax_report_error = NULL, updated_at = NOW() WHERE id = $1",
      [id]
    );

    res.json({ ok: true, status: 'processing' });

    setImmediate(async () => {
      try {
        const { downloadFile } = require('../services/s3');
        const { extractPdfData } = require('../services/pdfExtract');
        const { analyzeTaxReturn } = require('../services/taxAnalysis');
        const { extractCore1040Facts } = require('../services/taxFactExtractor');

        const buffer = await downloadFile({ bucket: delivery.s3_bucket, key: delivery.s3_key });

        const pdfData = await extractPdfData(buffer);
        const verifiedFacts = extractCore1040Facts(pdfData);
        const reportData = await analyzeTaxReturn(pdfData.text, verifiedFacts, firmId);

        await pool.query(
          "UPDATE tax_deliveries SET tax_report_data = $1, tax_report_status = 'completed', updated_at = NOW() WHERE id = $2",
          [JSON.stringify(reportData), id]
        );
      } catch (err) {
        console.error('[tax-delivery] generate-summary async error:', err);
        await pool.query(
          "UPDATE tax_deliveries SET tax_report_status = 'error', tax_report_error = $1, updated_at = NOW() WHERE id = $2",
          [err.message || 'Unknown error', id]
        ).catch(() => {});
      }
    });

  } catch (err) {
    console.error('[tax-delivery] POST /:id/generate-summary error:', err);
    res.status(500).json({ error: 'Failed to start summary generation' });
  }
});

// ── GET /tax-deliveries/:id/summary ──────────────────────────────────────
router.get('/:id/summary', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      'SELECT tax_report_data, tax_report_status, tax_report_error FROM tax_deliveries WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    res.json({
      status: rows[0].tax_report_status || 'none',
      data: rows[0].tax_report_data || null,
      error: rows[0].tax_report_error || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ── POST /tax-deliveries/:id/regenerate-signed-pdf ───────────────────────
// Re-generates the combined signed PDF from stored signature data (all signers must have signed)
router.post('/:id/regenerate-signed-pdf', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  try {
    const { rows: [d] } = await pool.query(
      `SELECT td.*, f.name as firm_name FROM tax_deliveries td JOIN firms f ON f.id = td.firm_id WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!d) return res.status(404).json({ error: 'Delivery not found' });
    if (!d.signature_doc_id) return res.status(400).json({ error: 'No signature document on this delivery' });

    const { rows: signers } = await pool.query(
      `SELECT tds.*, p.first_name, p.last_name, p.email as person_email, p.spouse_name, p.spouse_email
       FROM tax_delivery_signers tds JOIN people p ON p.id = tds.person_id
       WHERE tds.delivery_id = $1 AND tds.signed_at IS NOT NULL
       ORDER BY CASE WHEN tds.signer_role = 'taxpayer' THEN 0 ELSE 1 END`,
      [id]
    );
    if (!signers.length) return res.status(400).json({ error: 'No signed signers found' });

    const { rows: [sigDoc] } = await pool.query('SELECT * FROM documents WHERE id = $1', [d.signature_doc_id]);
    const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
    const { downloadFile, uploadFile, buildKey } = require('../services/s3');
    const { embedSignature } = require('../services/sign-pdf');

    let pdfBuffer = await downloadFile({ key: sigDoc.s3_key, bucket: sigDoc.s3_bucket || bucket });
    for (const s of signers) {
      const isSpouse = s.signer_role === 'spouse';
      const name = isSpouse ? (s.spouse_name || 'Spouse') : `${s.first_name} ${s.last_name}`.trim();
      const email = isSpouse ? (s.spouse_email || '') : (s.person_email || '');
      pdfBuffer = await embedSignature(pdfBuffer, { name, email, signedAt: s.signed_at, signedIp: s.signed_ip || '', signatureData: s.signature_data, signatureType: s.signature_type || 'drawn', taxYear: d.tax_year, firmName: d.firm_name });
    }

    const signedKey = buildKey({ firmId: d.firm_id, ownerType: 'tax_signed', ownerId: 0, year: String(d.tax_year), docType: 'signed_return', filename: `signed_${Date.now()}.pdf` });
    await uploadFile({ firmId: firmId, buffer: pdfBuffer, key: signedKey, mimeType: 'application/pdf', bucket });

    const taxpayer = signers.find(s => s.signer_role === 'taxpayer') || signers[0];
    const clientName = `${taxpayer.first_name} ${taxpayer.last_name}`.trim();
    const docOwnerType = d.company_id ? 'company' : 'person';
    const docOwnerId = d.company_id || taxpayer.person_id;
    const { rows: [newDoc] } = await pool.query(
      `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type, size_bytes, s3_key, s3_bucket, folder_section, folder_category, year, is_delivered, delivered_at)
       VALUES ($1, $2, $3, 'signed_return', $4, 'application/pdf', $5, $6, $7, 'firm_uploaded', 'tax', $8, true, NOW()) RETURNING id`,
      [d.firm_id, docOwnerType, docOwnerId, `${d.tax_year} Tax Return — Fully Signed (${clientName}).pdf`, pdfBuffer.length, signedKey, bucket, String(d.tax_year)]
    );
    await pool.query('UPDATE tax_deliveries SET signed_doc_id = $1 WHERE id = $2', [newDoc.id, id]);
    res.json({ ok: true, documentId: newDoc.id });
  } catch (err) {
    console.error('[tax-delivery] regenerate-signed-pdf error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.advancePipelineJob = advancePipelineJob;
