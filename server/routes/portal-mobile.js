'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { getSignedDownloadUrl } = require('../services/s3');

const router = Router();

// Strip internal QA keys from tax report data before it reaches a client.
// Keep in sync with the copy in portal.js.
const INTERNAL_TAX_REPORT_KEYS = ['verified_facts', 'verified_fact_status', 'verified_fact_missing', 'core_fact_reconciliation_issues'];
function sanitizeTaxReportData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data || null;
  const clean = { ...data };
  for (const key of INTERNAL_TAX_REPORT_KEYS) delete clean[key];
  return clean;
}

function toBool(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  return Boolean(value);
}

async function getAccessibleCompanyIds(firmId, personId) {
  const { rows } = await pool.query(
    `SELECT pca.company_id
     FROM person_company_access pca
     JOIN people p ON p.id = pca.person_id
     JOIN companies c ON c.id = pca.company_id
     WHERE pca.person_id = $1 AND p.firm_id = $2 AND c.firm_id = $2`,
    [personId, firmId]
  );
  return rows.map(r => r.company_id);
}

async function getSignerForDelivery(deliveryId, personId, signerRole) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_delivery_signers
     WHERE delivery_id = $1 AND person_id = $2 AND signer_role = $3
     LIMIT 1`,
    [deliveryId, personId, signerRole || 'taxpayer']
  );
  return rows[0] || null;
}

function buildAllowedActions(delivery, signer) {
  const status = delivery.status;
  const hasSigner = Boolean(signer);
  return {
    canViewReviewDocument: hasSigner && Boolean(delivery.review_doc_id),
    canViewSignatureDocument: hasSigner && Boolean(delivery.signature_doc_id),
    canApprove: hasSigner && !signer.approved_at && ['sent', 'needs_changes'].includes(status),
    canRequestChanges: hasSigner && !signer.needs_changes_at && ['sent', 'approved'].includes(status),
    canSign: hasSigner && Boolean(signer.approved_at) && !signer.signed_at && ['sent', 'approved'].includes(status),
  };
}

// GET /portal/mobile/dashboard
// Compact home payload for the native app; detailed screens should reuse existing portal endpoints.
router.get('/dashboard', async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;

  try {
    const [personRes, firmRes, companyIds] = await Promise.all([
      pool.query(
        `SELECT id, first_name, last_name, email, phone, organizer_visible
         FROM people WHERE id = $1 AND firm_id = $2`,
        [personId, firmId]
      ),
      pool.query('SELECT active_tax_year FROM firms WHERE id = $1', [firmId]),
      getAccessibleCompanyIds(firmId, personId),
    ]);

    if (!personRes.rows[0]) return res.status(404).json({ error: 'Person not found' });

    const person = personRes.rows[0];
    const activeTaxYear = firmRes.rows[0]?.active_tax_year || String(new Date().getFullYear() - 1);

    const messageCountPromise = pool.query(
      `SELECT COUNT(*)::int AS count
       FROM message_threads mt
       JOIN messages m ON m.thread_id = mt.id
       WHERE mt.person_id = $1 AND mt.firm_id = $2
         AND m.sender_type IN ('staff', 'agent')
         AND m.is_internal = false
         AND m.read_at IS NULL`,
      [personId, firmId]
    );

    const documentCountPromise = companyIds.length
      ? pool.query(
          `SELECT COUNT(*)::int AS count
           FROM documents
           WHERE firm_id = $1 AND folder_section NOT IN ('private', 'client_uploaded') AND viewed_at IS NULL AND COALESCE(delivered_at, created_at) > NOW() - INTERVAL '30 days'
             AND ((owner_type = 'person' AND owner_id = $2) OR (owner_type = 'company' AND owner_id = ANY($3)))`,
          [firmId, personId, companyIds]
        )
      : pool.query(
          `SELECT COUNT(*)::int AS count
           FROM documents
           WHERE firm_id = $1 AND folder_section NOT IN ('private', 'client_uploaded') AND viewed_at IS NULL AND COALESCE(delivered_at, created_at) > NOW() - INTERVAL '30 days'
             AND owner_type = 'person' AND owner_id = $2`,
          [firmId, personId]
        );

    const taxDeliveryPromise = pool.query(
      `SELECT td.id, td.title, td.tax_year, td.status, td.updated_at,
              tds.approved_at, tds.signed_at, tds.needs_changes_at
       FROM tax_deliveries td
       JOIN tax_delivery_signers tds ON tds.delivery_id = td.id
       WHERE td.firm_id = $1 AND tds.person_id = $2 AND tds.signer_role = $3
         AND td.status IN ('sent', 'approved', 'needs_changes')
       ORDER BY td.updated_at DESC NULLS LAST, td.created_at DESC
       LIMIT 10`,
      [firmId, personId, req.portal.signerRole || 'taxpayer']
    );

    const organizerPromise = pool.query(
      `SELECT o.id, o.tax_year, o.status, o.submitted_at,
              COUNT(i.id) FILTER (WHERE i.status = 'pending')::int AS pending_items
       FROM tax_organizers o
       LEFT JOIN tax_organizer_items i ON i.organizer_id = o.id
       WHERE o.firm_id = $1 AND o.person_id = $2 AND o.tax_year = $3
       GROUP BY o.id`,
      [firmId, personId, activeTaxYear]
    ).catch(err => {
      if (err.code === '42P01') return { rows: [] };
      throw err;
    });

    const bookkeepingPromise = companyIds.length
      ? pool.query(
          `SELECT COUNT(*)::int AS count
           FROM bookkeeper_uncoded bu
           JOIN companies c ON c.realm_id = bu.realm_id
           WHERE c.id = ANY($1) AND bu.sent_to_client = TRUE AND bu.coded_by_client = FALSE
             AND (bu.amount IS NOT NULL AND bu.amount != 0)`,
          [companyIds]
        ).catch(err => {
          if (err.code === '42P01' || err.code === '42703') return { rows: [{ count: 0 }] };
          throw err;
        })
      : Promise.resolve({ rows: [{ count: 0 }] });

    const recentDocsPromise = companyIds.length
      ? pool.query(
          `SELECT id, display_name, owner_type, owner_id, year, folder_category, created_at
           FROM documents
           WHERE firm_id = $1 AND folder_section != 'private'
             AND ((owner_type = 'person' AND owner_id = $2) OR (owner_type = 'company' AND owner_id = ANY($3)))
           ORDER BY created_at DESC LIMIT 5`,
          [firmId, personId, companyIds]
        )
      : pool.query(
          `SELECT id, display_name, owner_type, owner_id, year, folder_category, created_at
           FROM documents
           WHERE firm_id = $1 AND folder_section != 'private' AND owner_type = 'person' AND owner_id = $2
           ORDER BY created_at DESC LIMIT 5`,
          [firmId, personId]
        );

    const [messages, documents, deliveries, organizer, bookkeeping, recentDocs] = await Promise.all([
      messageCountPromise,
      documentCountPromise,
      taxDeliveryPromise,
      organizerPromise,
      bookkeepingPromise,
      recentDocsPromise,
    ]);

    const deliveryTasks = deliveries.rows.filter(d =>
      !d.needs_changes_at && (!d.approved_at || (d.approved_at && !d.signed_at))
    );
    const organizerRow = organizer.rows[0] || null;
    const organizerPending = organizerRow && organizerRow.status !== 'submitted'
      ? (organizerRow.pending_items || 0)
      : 0;

    res.json({
      profile: {
        id: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email,
        phone: person.phone,
        signerRole: req.portal.signerRole || 'taxpayer',
        activeTaxYear,
        organizerVisible: Boolean(person.organizer_visible),
      },
      counts: {
        unreadMessages: messages.rows[0]?.count || 0,
        unviewedDocuments: documents.rows[0]?.count || 0,
        taxDeliveriesRequiringAction: deliveryTasks.length,
        organizerPendingItems: organizerPending,
        bookkeepingQuestions: bookkeeping.rows[0]?.count || 0,
        totalTasks: deliveryTasks.length + organizerPending + (bookkeeping.rows[0]?.count || 0),
      },
      tasks: {
        taxDeliveries: deliveryTasks.map(d => ({
          id: d.id,
          title: d.title,
          taxYear: d.tax_year,
          status: d.status,
          approvedAt: d.approved_at,
          signedAt: d.signed_at,
          updatedAt: d.updated_at,
        })),
        organizer: organizerRow,
        bookkeepingQuestions: bookkeeping.rows[0]?.count || 0,
      },
      recentActivity: recentDocs.rows.map(d => ({ type: 'document', ...d })),
    });
  } catch (err) {
    console.error('[portal-mobile] GET /dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch mobile dashboard' });
  }
});

// POST /portal/mobile/devices
router.post('/devices', async (req, res) => {
  const firmId = req.portal.firmId;
  const personId = req.portal.personId;
  const pushToken = (req.body.pushToken || req.body.push_token || req.body.token || '').trim();
  const platform = (req.body.platform || '').trim().toLowerCase();

  if (!pushToken) return res.status(400).json({ error: 'pushToken is required' });
  if (platform && !['ios', 'android', 'web', 'unknown'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be ios, android, web, or unknown' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO portal_mobile_devices
         (firm_id, person_id, push_token, platform, device_id, app_version, device_model, os_version, metadata, last_seen_at, session_id, signer_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11)
       ON CONFLICT (firm_id, person_id, push_token)
       DO UPDATE SET
         platform = EXCLUDED.platform,
         device_id = EXCLUDED.device_id,
         app_version = EXCLUDED.app_version,
         device_model = EXCLUDED.device_model,
         os_version = EXCLUDED.os_version,
         metadata = EXCLUDED.metadata,
         session_id = EXCLUDED.session_id,
         signer_role = EXCLUDED.signer_role,
         disabled_at = NULL,
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING id, platform, device_id, app_version, device_model, os_version,
                 disabled_at, last_seen_at, created_at, updated_at`,
      [
        firmId,
        personId,
        pushToken,
        platform || 'unknown',
        req.body.deviceId || req.body.device_id || '',
        req.body.appVersion || req.body.app_version || '',
        req.body.deviceModel || req.body.device_model || '',
        req.body.osVersion || req.body.os_version || '',
        req.body.metadata || {},
        req.portal.sessionId || null,
        req.portal.signerRole,
      ]
    );
    res.status(201).json({ device: rows[0] });
  } catch (err) {
    console.error('[portal-mobile] POST /devices error:', err);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// DELETE /portal/mobile/devices/:id
router.delete('/devices/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid device id' });

  try {
    const { rowCount } = await pool.query(
      `UPDATE portal_mobile_devices
       SET disabled_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND person_id = $2 AND firm_id = $3 AND disabled_at IS NULL`,
      [id, req.portal.personId, req.portal.firmId]
    );
    res.json({ ok: true, removed: rowCount > 0 });
  } catch (err) {
    console.error('[portal-mobile] DELETE /devices/:id error:', err);
    res.status(500).json({ error: 'Failed to remove device' });
  }
});

// POST /portal/mobile/logout — optional cleanup when the app signs out.
router.post('/logout', async (req, res) => {
  const pushToken = (req.body.pushToken || req.body.push_token || req.body.token || '').trim();
  const deviceId = req.body.deviceId || req.body.device_id || '';
  const id = req.body.id ? parseInt(req.body.id, 10) : null;

  try {
    let rowCount = 0;
    if (Number.isInteger(id)) {
      const result = await pool.query(
        `UPDATE portal_mobile_devices SET disabled_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND person_id = $2 AND firm_id = $3`,
        [id, req.portal.personId, req.portal.firmId]
      );
      rowCount += result.rowCount;
    }
    if (pushToken) {
      const result = await pool.query(
        `UPDATE portal_mobile_devices SET disabled_at = NOW(), updated_at = NOW()
         WHERE push_token = $1 AND person_id = $2 AND firm_id = $3`,
        [pushToken, req.portal.personId, req.portal.firmId]
      );
      rowCount += result.rowCount;
    } else if (deviceId) {
      const result = await pool.query(
        `UPDATE portal_mobile_devices SET disabled_at = NOW(), updated_at = NOW()
         WHERE device_id = $1 AND person_id = $2 AND firm_id = $3`,
        [deviceId, req.portal.personId, req.portal.firmId]
      );
      rowCount += result.rowCount;
    }
    res.json({ ok: true, removed: rowCount > 0 });
  } catch (err) {
    console.error('[portal-mobile] POST /logout error:', err);
    res.status(500).json({ error: 'Failed to clean up device' });
  }
});

// GET /portal/mobile/notification-preferences
router.get('/notification-preferences', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO portal_mobile_notification_preferences (firm_id, person_id)
       VALUES ($1, $2)
       ON CONFLICT (firm_id, person_id) DO UPDATE SET updated_at = portal_mobile_notification_preferences.updated_at
       RETURNING messages_enabled, documents_enabled, tasks_enabled, tax_delivery_enabled,
                 marketing_enabled, quiet_hours, timezone, updated_at`,
      [req.portal.firmId, req.portal.personId]
    );
    res.json({ preferences: rows[0] });
  } catch (err) {
    console.error('[portal-mobile] GET /notification-preferences error:', err);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

// PUT /portal/mobile/notification-preferences
router.put('/notification-preferences', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO portal_mobile_notification_preferences
         (firm_id, person_id, messages_enabled, documents_enabled, tasks_enabled, tax_delivery_enabled,
          marketing_enabled, quiet_hours, timezone, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (firm_id, person_id)
       DO UPDATE SET
         messages_enabled = EXCLUDED.messages_enabled,
         documents_enabled = EXCLUDED.documents_enabled,
         tasks_enabled = EXCLUDED.tasks_enabled,
         tax_delivery_enabled = EXCLUDED.tax_delivery_enabled,
         marketing_enabled = EXCLUDED.marketing_enabled,
         quiet_hours = EXCLUDED.quiet_hours,
         timezone = EXCLUDED.timezone,
         updated_at = NOW()
       RETURNING messages_enabled, documents_enabled, tasks_enabled, tax_delivery_enabled,
                 marketing_enabled, quiet_hours, timezone, updated_at`,
      [
        req.portal.firmId,
        req.portal.personId,
        toBool(req.body.messagesEnabled ?? req.body.messages_enabled, true),
        toBool(req.body.documentsEnabled ?? req.body.documents_enabled, true),
        toBool(req.body.tasksEnabled ?? req.body.tasks_enabled, true),
        toBool(req.body.taxDeliveryEnabled ?? req.body.tax_delivery_enabled, true),
        toBool(req.body.marketingEnabled ?? req.body.marketing_enabled, false),
        req.body.quietHours || req.body.quiet_hours || {},
        req.body.timezone || '',
      ]
    );
    res.json({ preferences: rows[0] });
  } catch (err) {
    console.error('[portal-mobile] PUT /notification-preferences error:', err);
    res.status(500).json({ error: 'Failed to update notification preferences' });
  }
});

// GET /portal/mobile/tax-deliveries/:id
router.get('/tax-deliveries/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid delivery id' });

  try {
    const signer = await getSignerForDelivery(id, req.portal.personId, req.portal.signerRole);
    const companyIds = await getAccessibleCompanyIds(req.portal.firmId, req.portal.personId);

    const { rows } = await pool.query(
      `SELECT td.*, co.company_name, COALESCE(NULLIF(f.display_name, ''), f.name) AS firm_name,
              review_doc.display_name AS review_doc_name,
              review_doc.mime_type AS review_doc_mime_type,
              review_doc.size_bytes AS review_doc_size_bytes,
              review_doc.s3_key AS review_s3_key,
              review_doc.s3_bucket AS review_s3_bucket,
              sig_doc.display_name AS signature_doc_name,
              sig_doc.mime_type AS signature_doc_mime_type,
              sig_doc.size_bytes AS signature_doc_size_bytes,
              sig_doc.s3_key AS signature_s3_key,
              sig_doc.s3_bucket AS signature_s3_bucket,
              COALESCE(NULLIF(fu.display_name, ''), fu.name) AS preparer_name,
              fu.credentials AS preparer_credentials,
              fu.avatar_url AS preparer_avatar_key
       FROM tax_deliveries td
       JOIN firms f ON f.id = td.firm_id
       LEFT JOIN companies co ON co.id = td.company_id
       LEFT JOIN documents review_doc ON review_doc.id = td.review_doc_id
       LEFT JOIN documents sig_doc ON sig_doc.id = td.signature_doc_id
       LEFT JOIN firm_users fu ON fu.id = td.created_by AND fu.firm_id = td.firm_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, req.portal.firmId]
    );

    const delivery = rows[0];
    if (!delivery) return res.status(404).json({ error: 'Tax delivery not found' });

    const hasCompanyAccess = delivery.company_id && companyIds.includes(delivery.company_id);
    if (!signer && !hasCompanyAccess) return res.status(403).json({ error: 'Access denied' });

    const signersRes = await pool.query(
      `SELECT tds.id, tds.person_id, tds.signer_role, tds.approved_at, tds.signed_at,
              tds.needs_changes_at, tds.needs_changes_note,
              p.first_name, p.last_name, p.spouse_name
       FROM tax_delivery_signers tds
       JOIN people p ON p.id = tds.person_id
       WHERE tds.delivery_id = $1
       ORDER BY CASE WHEN tds.signer_role = 'taxpayer' THEN 0 ELSE 1 END, tds.id`,
      [id]
    );

    const canAccessSignerDocuments = Boolean(signer);
    const reviewDocument = delivery.review_doc_id ? {
      id: delivery.review_doc_id,
      name: delivery.review_doc_name,
      mimeType: delivery.review_doc_mime_type,
      sizeBytes: delivery.review_doc_size_bytes,
      apiUrl: canAccessSignerDocuments ? `/portal/tax-deliveries/${id}/download-review` : null,
      signedUrl: canAccessSignerDocuments && delivery.review_s3_key
        ? await getSignedDownloadUrl({ key: delivery.review_s3_key, bucket: delivery.review_s3_bucket })
        : null,
    } : null;

    const signatureDocument = delivery.signature_doc_id ? {
      id: delivery.signature_doc_id,
      name: delivery.signature_doc_name,
      mimeType: delivery.signature_doc_mime_type,
      sizeBytes: delivery.signature_doc_size_bytes,
      apiUrl: canAccessSignerDocuments ? `/portal/tax-deliveries/${id}/download-signature` : null,
      signedUrl: canAccessSignerDocuments && delivery.signature_s3_key
        ? await getSignedDownloadUrl({ key: delivery.signature_s3_key, bucket: delivery.signature_s3_bucket })
        : null,
    } : null;

    let preparerAvatarUrl = null;
    if (delivery.preparer_avatar_key) {
      try {
        preparerAvatarUrl = await getSignedDownloadUrl({ key: delivery.preparer_avatar_key, bucket: process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-docs' });
      } catch (e) { /* non-fatal */ }
    }

    res.json({
      delivery: {
        id: delivery.id,
        firmName: delivery.firm_name,
        companyId: delivery.company_id,
        companyName: delivery.company_name,
        taxYear: delivery.tax_year,
        title: delivery.title,
        introNote: delivery.intro_note,
        taxSummary: delivery.tax_summary || {},
        taxReportStatus: delivery.tax_report_status || 'none',
        taxReportData: sanitizeTaxReportData(delivery.tax_report_data),
        status: delivery.status,
        needsChangesNote: delivery.needs_changes_note,
        filedAt: delivery.filed_at || null,
        filedDateKnown: delivery.filed_date_known !== false,
        acceptedAt: delivery.accepted_at || null,
        signedDocId: delivery.signed_doc_id || null,
        preparer: delivery.preparer_name ? {
          name: delivery.preparer_name,
          credentials: delivery.preparer_credentials || '',
          avatarUrl: preparerAvatarUrl,
        } : null,
        createdAt: delivery.created_at,
        updatedAt: delivery.updated_at,
      },
      currentSigner: signer ? {
        id: signer.id,
        signerRole: signer.signer_role,
        approvedAt: signer.approved_at,
        signedAt: signer.signed_at,
        needsChangesAt: signer.needs_changes_at,
        needsChangesNote: signer.needs_changes_note,
      } : null,
      signers: signersRes.rows.map(s => ({
        id: s.id,
        signerRole: s.signer_role,
        isMe: Boolean(signer && s.id === signer.id),
        name: s.signer_role === 'spouse'
          ? (s.spouse_name || `${s.first_name || ''} ${s.last_name || ''}`.trim())
          : `${s.first_name || ''} ${s.last_name || ''}`.trim(),
        approvedAt: s.approved_at,
        signedAt: s.signed_at,
        needsChangesAt: s.needs_changes_at,
      })),
      allowedActions: buildAllowedActions(delivery, signer),
      documents: {
        review: reviewDocument,
        signature: signatureDocument,
      },
      actionEndpoints: {
        approve: `/portal/tax-deliveries/${id}/approve`,
        requestChanges: `/portal/tax-deliveries/${id}/needs-changes`,
        sign: `/portal/tax-deliveries/${id}/sign`,
      },
      consentLanguage: `By approving and signing in the ${delivery.firm_name || 'client'} portal, you confirm that you have reviewed the tax return packet, authorize ${delivery.firm_name || 'your firm'} to proceed, and agree that your electronic signature has the same legal effect as a handwritten signature.`,
    });
  } catch (err) {
    console.error('[portal-mobile] GET /tax-deliveries/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch tax delivery packet' });
  }
});

module.exports = router;
