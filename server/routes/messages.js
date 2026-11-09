'use strict';
const { completeText } = require('../services/managedInference');

const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { staffInboxPredicate } = require('../services/staffInboxVisibility');
const { classifyMessage } = require('../services/claude');
const { sendPortalNotification } = require('../services/email');
const { createReplyToken } = require('../services/emailReplyTokens');
const { archiveClientMessageCreatedFailClosed, archiveClientMessageRemoved } = require('../services/communicationArchive');
const { sendClientMobilePush } = require('../services/mobilePush');
const { uploadFile, buildKey, sanitizeFilename, getSignedDownloadUrl, downloadFile } = require('../services/s3');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 8 },
});

const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

async function currentFirmUserId(req) {
  if (req.firm.userId) return req.firm.userId;
  const { rows } = await pool.query(
    'SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 LIMIT 1',
    [req.firm.id, req.firm.email]
  );
  return rows[0]?.id || null;
}

function parseDocumentIds(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  const ids = [];
  for (const item of raw) {
    String(item || '').split(',').forEach(part => {
      const n = parseInt(part, 10);
      if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
    });
  }
  return ids.slice(0, 20);
}

async function allowedThreadDocumentIds({ firmId, threadId, documentIds }) {
  if (!documentIds.length) return [];
  const { rows } = await pool.query(
    `WITH thread_scope AS (
       SELECT mt.person_id
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id AND p.firm_id = mt.firm_id
       WHERE mt.id = $2 AND mt.firm_id = $1
     )
     SELECT d.id
     FROM documents d
     CROSS JOIN thread_scope ts
     WHERE d.firm_id = $1
       AND d.id = ANY($3::int[])
       AND (
         (d.owner_type = 'person' AND d.owner_id = ts.person_id)
         OR (d.owner_type = 'company' AND d.owner_id IN (SELECT company_id FROM person_company_access WHERE person_id = ts.person_id))
       )`,
    [firmId, threadId, documentIds]
  );
  return rows.map(r => Number(r.id));
}

async function attachExistingDocuments({ firmId, threadId, messageId, documentIds }) {
  const allowedIds = await allowedThreadDocumentIds({ firmId, threadId, documentIds });
  if (allowedIds.length !== documentIds.length) {
    const err = new Error('One or more selected documents are not available for this client/thread.');
    err.statusCode = 403;
    throw err;
  }
  for (const documentId of allowedIds) {
    await pool.query(
      'INSERT INTO message_attachments (message_id, document_id) VALUES ($1, $2)',
      [messageId, documentId]
    );
  }
}

function documentPickerDto(row) {
  const ownerName = row.owner_type === 'company'
    ? (row.company_name || 'Company')
    : (row.person_name || 'Person');
  return {
    id: row.id,
    displayName: row.display_name || 'Document',
    year: row.year || '',
    category: row.folder_category || row.doc_type || 'other',
    section: row.folder_section || '',
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    ownerName,
    mimeType: row.mime_type || '',
    sizeBytes: row.size_bytes || 0,
    createdAt: row.created_at || null,
  };
}

/**
 * Client message notification sender.
 * For now, send immediately for every staff-to-client message so clients do not
 * miss notifications while the reply-by-email flow is being tested and tuned.
 */
async function buildNotificationAttachments(messageId, firmId) {
  if (!messageId) return [];
  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
  const { rows } = await pool.query(
    `SELECT d.id, d.display_name, d.mime_type, d.size_bytes, d.s3_key, d.s3_bucket
     FROM message_attachments ma
     JOIN documents d ON d.id = ma.document_id
     WHERE ma.message_id = $1 AND d.firm_id = $2
     ORDER BY ma.id ASC`,
    [messageId, firmId]
  );
  const attachments = [];
  let totalBytes = 0;
  for (const doc of rows) {
    const size = Number(doc.size_bytes || 0);
    if (!doc.s3_key || !doc.s3_bucket) continue;
    if (size > MAX_ATTACHMENT_BYTES || totalBytes + size > MAX_TOTAL_BYTES) {
      console.warn(`[notify] skipping oversized email attachment document ${doc.id}`);
      continue;
    }
    try {
      const buffer = await downloadFile({ key: doc.s3_key, bucket: doc.s3_bucket });
      if (buffer.length > MAX_ATTACHMENT_BYTES || totalBytes + buffer.length > MAX_TOTAL_BYTES) {
        console.warn(`[notify] skipping oversized email attachment document ${doc.id}`);
        continue;
      }
      totalBytes += buffer.length;
      attachments.push({
        filename: sanitizeFilename(doc.display_name || `document-${doc.id}`),
        content: buffer.toString('base64'),
        content_type: doc.mime_type || 'application/octet-stream',
      });
    } catch (err) {
      console.warn(`[notify] failed to load email attachment document ${doc.id}: ${err.message}`);
    }
  }
  return attachments;
}

function scheduleClientNotification({ threadId, personId, toEmail, toName, firmName, firmId, messagePreview, messageId }) {
  if (!toEmail) return;

  (async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id FROM people WHERE id = $1`,
        [personId]
      );
      if (!rows[0]) return;

      // Build message preview — show first 300 chars, truncate cleanly
      const preview = messagePreview
        ? (messagePreview.length > 300 ? messagePreview.slice(0, 297).trimEnd() + '…' : messagePreview)
        : 'You have a new message from your advisor.';

      let replyToken = null;
      try {
        replyToken = await createReplyToken({
          firmId,
          threadId,
          personId,
          staffUserId: null,
          purpose: 'message_notification',
        });
      } catch (tokenErr) {
        console.error('[notify] reply token creation failed (non-fatal):', tokenErr.message);
      }

      const attachments = await buildNotificationAttachments(messageId, firmId);

      await sendPortalNotification({
        to: toEmail,
        name: toName,
        firmName,
        firmId,
        message: preview,
        portalUrl: APP_URL + '/portal',
        replyTo: replyToken?.reply_address,
        replyAddress: replyToken?.reply_address,
        attachments,
      });

      await pool.query(
        `UPDATE people SET last_notification_sent_at = NOW() WHERE id = $1`,
        [personId]
      );
      console.log(`[notify] sent to ${toEmail} (person ${personId})`);
    } catch (e) {
      console.error('[notify] error (non-fatal):', e.message);
    }
  })();
}

function cancelPendingNotification(personId) {
  // Notifications are immediate right now, so there is no pending timer to cancel.
}

async function applyClassification(threadId, firmId, personId, body) {
  try {
    const result = await classifyMessage({ body, personId, firmId });
    if (result.category) {
      await pool.query('UPDATE message_threads SET category = $1 WHERE id = $2', [result.category, threadId]);
    }
    for (const c of (result.companies || [])) {
      await pool.query(
        `INSERT INTO thread_companies (thread_id, company_id, ai_confidence, added_by)
         VALUES ($1, $2, $3, 'ai')
         ON CONFLICT (thread_id, company_id) DO NOTHING`,
        [threadId, c.id, c.confidence]
      );
    }
  } catch (err) {
    console.error('[messages] classification error (non-fatal):', err.message);
  }
}

// ── GET /messages/staff-list — active staff for the firm (used by portal) ────
router.get('/staff-list', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(NULLIF(display_name, ''), name, email) as name, email, avatar_url
       FROM firm_users
       WHERE firm_id = $1 AND archived_at IS NULL
       ORDER BY name`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /messages/staff-list] error:', err);
    res.status(500).json({ error: 'Failed to fetch staff list' });
  }
});

// Inbound texts that cannot be matched are kept visible to every staff inbox
// instead of being silently stranded in webhook logs.
router.get('/sms-exceptions', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, from_phone, body, match_status, created_at
         FROM twilio_inbound_sms_events
        WHERE firm_id = $1
          AND match_status IN ('unmatched', 'ambiguous')
          AND resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT 25`,
      [firmId]
    );
    res.json(rows.map(row => ({
      id: row.id,
      fromPhone: row.from_phone,
      body: row.body,
      matchStatus: row.match_status,
      createdAt: row.created_at,
    })));
  } catch (err) {
    console.error('[GET /messages/sms-exceptions] error:', err);
    res.status(500).json({ error: 'Failed to fetch unmatched text messages' });
  }
});

router.put('/sms-exceptions/:eventId/resolve', async (req, res) => {
  const firmId = req.firm.id;
  const eventId = Number.parseInt(req.params.eventId, 10);
  if (!eventId) return res.status(400).json({ error: 'Invalid text event' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE twilio_inbound_sms_events
          SET resolved_at = NOW()
        WHERE id = $1 AND firm_id = $2
          AND match_status IN ('unmatched', 'ambiguous')`,
      [eventId, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Text event not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/sms-exceptions/:eventId/resolve] error:', err);
    res.status(500).json({ error: 'Failed to resolve unmatched text message' });
  }
});

// ── GET /messages/all — all firm threads (for conversation summaries, any staff) ──
router.get('/all', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows: threads } = await pool.query(
      `SELECT mt.*,
         p.first_name, p.last_name, p.email as person_email,
         fu.name as staff_name,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT created_at FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) as last_message_at_sub,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.sender_type = 'client' AND m.read_at IS NULL) as unread_count
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN firm_users fu ON fu.id = mt.staff_user_id
       WHERE mt.firm_id = $1 AND mt.status != 'archived'
       ORDER BY mt.last_message_at DESC NULLS LAST`,
      [firmId]
    );

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      staffUserId: t.staff_user_id,
      staffName: t.staff_name || null,
      person: {
        id: t.person_id,
        firstName: t.first_name,
        lastName: t.last_name,
        email: t.person_email,
      },
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
    })));
  } catch (err) {
    console.error('[GET /messages/all] error:', err);
    res.status(500).json({ error: 'Failed to fetch all threads' });
  }
});

// ── GET /messages/unread-count — lightweight browser/tab badge count ───────
router.get('/unread-count', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const userId = await currentFirmUserId(req);
    if (!userId) return res.json({ unread_count: 0, task_count: 0, document_upload_count: 0, total: 0 });

    const { rows } = await pool.query(
      `WITH my_threads AS (
         SELECT mt.id, mt.category,
                EXISTS (
                  SELECT 1 FROM messages task_msg
                  WHERE task_msg.thread_id = mt.id AND task_msg.removed_at IS NULL AND task_msg.message_type = 'task'
                ) AS has_task_messages
         FROM message_threads mt
         LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $2 AND tp.archived_at IS NULL
         WHERE mt.firm_id = $1
           AND mt.status != 'archived'
           AND (mt.staff_user_id != $2 OR mt.staff_archived_at IS NULL)
           AND (mt.staff_user_id = $2 OR tp.id IS NOT NULL)
       )
       SELECT
         COALESCE((
           SELECT COUNT(*)
           FROM messages m
           JOIN my_threads t ON t.id = m.thread_id
           WHERE m.sender_type = 'client' AND m.removed_at IS NULL AND m.read_at IS NULL
         ), 0)::int AS unread_count,
         COALESCE((
           SELECT COUNT(*)
           FROM my_threads t
           WHERE t.category = 'internal' AND t.has_task_messages
         ), 0)::int AS task_count,
         COALESCE((
           SELECT COUNT(*)
           FROM document_upload_notification_recipients dnr
           WHERE dnr.firm_id = $1 AND dnr.staff_user_id = $2
             AND dnr.read_at IS NULL AND dnr.archived_at IS NULL
         ), 0)::int AS document_upload_count`,
      [firmId, userId]
    );

    const unread = parseInt(rows[0]?.unread_count || 0, 10) || 0;
    const tasks = parseInt(rows[0]?.task_count || 0, 10) || 0;
    const documentUploads = req.firm.isApiToken
      ? 0
      : (parseInt(rows[0]?.document_upload_count || 0, 10) || 0);
    res.json({ unread_count: unread, task_count: tasks, document_upload_count: documentUploads, total: unread + tasks + documentUploads });
  } catch (err) {
    console.error('[GET /messages/unread-count] error:', err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// ── GET /messages — My Inbox (threads assigned to current staff user) ─────────
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const showArchived = req.query.view === 'archived';

  try {
    const userId = await currentFirmUserId(req);
    const { rows: threads } = await pool.query(
      `SELECT mt.*,
         p.first_name, p.last_name, p.email as person_email,
         fu.name as staff_name,
         (mt.staff_user_id != $2) as is_participant,
         CASE WHEN mt.staff_user_id = $2 THEN mt.staff_archived_at ELSE tp.archived_at END AS archived_for_user_at,
         tp.added_by_id,
         adder.name as shared_by_name,
         fwd.forwarded_by_name,
         fwd.forwarded_note,
         fwd.forwarded_at,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT message_type FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) as last_message_type,
         (SELECT created_at FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) as last_message_at_sub,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.sender_type = 'client' AND m.read_at IS NULL) as unread_count,
         (SELECT COUNT(*) FROM message_drafts md WHERE md.thread_id = mt.id AND md.status = 'pending') as pending_draft_count,
         (SELECT COUNT(*) > 0 FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.message_type = 'task' LIMIT 1) as has_task_messages
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       JOIN firm_users fu ON fu.id = mt.staff_user_id
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $2
       LEFT JOIN firm_users adder ON adder.id = tp.added_by_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(NULLIF(fu2.display_name, ''), fu2.name, fu2.email) AS forwarded_by_name,
                mtf.note AS forwarded_note,
                mtf.created_at AS forwarded_at
         FROM message_thread_forwards mtf
         LEFT JOIN firm_users fu2 ON fu2.id = mtf.forwarded_by_id
         WHERE mtf.thread_id = mt.id AND mtf.firm_id = mt.firm_id AND mtf.forwarded_to_id = $2
         ORDER BY mtf.created_at DESC
         LIMIT 1
       ) fwd ON TRUE
       WHERE mt.firm_id = $1
         AND ${staffInboxPredicate('$2', '$3')}
       ORDER BY mt.last_message_at DESC NULLS LAST`,
      [firmId, userId, showArchived]
    );

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      staffUserId: t.staff_user_id,
      staffName: t.staff_name,
      isParticipant: t.is_participant,
      isArchived: showArchived,
      archivedAt: t.archived_for_user_at,
      sharedByName: t.shared_by_name || null,
      forwardedByName: t.forwarded_by_name || null,
      forwardedNote: t.forwarded_note || null,
      forwardedAt: t.forwarded_at || null,
      person: {
        id: t.person_id,
        firstName: t.first_name,
        lastName: t.last_name,
        email: t.person_email,
      },
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
      pendingDraftCount: parseInt(t.pending_draft_count, 10) || 0,
      hasTaskMessages: t.has_task_messages === true || t.has_task_messages === 'true',
    })));
  } catch (err) {
    console.error('[GET /messages] error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox' });
  }
});

// ── POST /messages/person/:personId/summary — AI digest of last 30 days ──────
router.post('/person/:personId/summary', async (req, res) => {
  const firmId = req.firm.id;
  const personId = parseInt(req.params.personId);
  try {
    const { rows: personRows } = await pool.query(
      'SELECT first_name, last_name FROM people WHERE id = $1 AND firm_id = $2', [personId, firmId]
    );
    if (!personRows[0]) return res.status(404).json({ error: 'Person not found' });
    const person = personRows[0];

    // Pull last 30 days of non-internal messages (both directions)
    const { rows: msgs } = await pool.query(`
      SELECT m.body, m.sender_type, m.created_at,
             CASE WHEN m.sender_type='staff' THEN COALESCE(NULLIF(fu.display_name, ''), fu.name, 'Staff') ELSE $3 END AS sender_name
      FROM messages m
      JOIN message_threads mt ON mt.id = m.thread_id
      LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
      WHERE mt.person_id = $1 AND mt.firm_id = $2
        AND m.is_internal = false
        AND m.removed_at IS NULL
        AND m.created_at > NOW() - INTERVAL '30 days'
        AND m.body IS NOT NULL AND m.body != ''
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [personId, firmId, `${person.first_name} ${person.last_name}`]);

    if (!msgs.length) return res.json({ summary: null, message: 'No messages in the last 30 days.' });

    const transcript = msgs.map(m =>
      `[${new Date(m.created_at).toLocaleDateString('en-US', {month:'short', day:'numeric'})} - ${m.sender_name}]: ${m.body.slice(0, 500)}`
    ).join('\n');

    const summary = await completeText({firmId,feature:'client-summary',maxTokens:600,prompt: `You are summarizing recent client communication for an advisor before a meeting or call.

Client: ${person.first_name} ${person.last_name}

Last 30 days of messages:
${transcript}

Write a concise, structured summary with these sections (only include sections that have content):
**Recent Topics** — key subjects discussed
**Action Items** — anything promised, requested, or outstanding  
**Documents** — any documents mentioned, sent, or requested
**Client Mood/Concerns** — any worries, questions, or tone worth noting

Be brief and actionable. No fluff.`
    });
    res.json({ summary, messageCount: msgs.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[POST /messages/person/:personId/summary] error:', err);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ── GET /messages/person/:personId ───────────────────────────────────────────
router.get('/person/:personId', async (req, res) => {
  const firmId = req.firm.id;
  const personId = parseInt(req.params.personId);
  const showArchived = req.query.view === 'archived';

  try {
    const params = [firmId, personId];
    let staffScopeSql = '';
    let staffArchiveSelectSql = 'NULL::timestamptz AS archived_for_user_at';
    if (req.query.scope === 'mine') {
      const userId = await currentFirmUserId(req);
      if (!userId) return res.json([]);
      params.push(userId);
      staffArchiveSelectSql = `CASE
        WHEN mt.staff_user_id = $${params.length} THEN mt.staff_archived_at
        ELSE (
          SELECT tp.archived_at
          FROM thread_participants tp
          WHERE tp.thread_id = mt.id AND tp.firm_user_id = $${params.length}
          LIMIT 1
        )
      END AS archived_for_user_at`;
      staffScopeSql = showArchived
        ? ` AND (
          (mt.staff_user_id = $${params.length} AND (mt.staff_archived_at IS NOT NULL OR mt.status = 'archived'))
          OR (
            mt.staff_user_id IS DISTINCT FROM $${params.length}
            AND EXISTS (
              SELECT 1
              FROM thread_participants tp
              WHERE tp.thread_id = mt.id AND tp.firm_user_id = $${params.length} AND tp.archived_at IS NOT NULL
            )
          )
        )`
        : ` AND mt.status != 'archived'
          AND (
            (mt.staff_user_id = $${params.length} AND mt.staff_archived_at IS NULL)
            OR (
              mt.staff_user_id IS DISTINCT FROM $${params.length}
              AND EXISTS (
                SELECT 1
                FROM thread_participants tp
                WHERE tp.thread_id = mt.id AND tp.firm_user_id = $${params.length} AND tp.archived_at IS NULL
              )
            )
          )`;
    }

    const { rows: threads } = await pool.query(
      `SELECT
         mt.id, mt.subject, mt.status, mt.category, mt.last_message_at, mt.created_at,
         mt.staff_user_id,
         fu.name as staff_name,
         ${staffArchiveSelectSql},
         (SELECT body FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count
       FROM message_threads mt
       LEFT JOIN firm_users fu ON fu.id = mt.staff_user_id
       WHERE mt.firm_id = $1 AND mt.person_id = $2
       ${staffScopeSql}
       ORDER BY mt.last_message_at DESC`,
      params
    );

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      staffUserId: t.staff_user_id,
      staffName: t.staff_name || null,
      isArchived: showArchived,
      archivedAt: t.archived_for_user_at,
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
    })));
  } catch (err) {
    console.error('[GET /messages/person/:personId] error:', err);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// ── GET /messages/company/:companyId ─────────────────────────────────────────
router.get('/company/:companyId', async (req, res) => {
  const firmId = req.firm.id;
  const companyId = parseInt(req.params.companyId);
  const showArchived = req.query.view === 'archived';

  try {
    const params = [firmId, companyId];
    let staffScopeSql = '';
    let staffArchiveSelectSql = 'NULL::timestamptz AS archived_for_user_at';
    if (req.query.scope === 'mine') {
      const userId = await currentFirmUserId(req);
      if (!userId) return res.json([]);
      params.push(userId);
      staffArchiveSelectSql = `CASE
        WHEN mt.staff_user_id = $${params.length} THEN mt.staff_archived_at
        ELSE (
          SELECT tp.archived_at
          FROM thread_participants tp
          WHERE tp.thread_id = mt.id AND tp.firm_user_id = $${params.length}
          LIMIT 1
        )
      END AS archived_for_user_at`;
      staffScopeSql = showArchived
        ? ` AND (
          (mt.staff_user_id = $${params.length} AND (mt.staff_archived_at IS NOT NULL OR mt.status = 'archived'))
          OR (
            mt.staff_user_id IS DISTINCT FROM $${params.length}
            AND EXISTS (
              SELECT 1
              FROM thread_participants tp
              WHERE tp.thread_id = mt.id AND tp.firm_user_id = $${params.length} AND tp.archived_at IS NOT NULL
            )
          )
        )`
        : ` AND mt.status != 'archived'
          AND (
            (mt.staff_user_id = $${params.length} AND mt.staff_archived_at IS NULL)
            OR (
              mt.staff_user_id IS DISTINCT FROM $${params.length}
              AND EXISTS (
                SELECT 1
                FROM thread_participants tp
                WHERE tp.thread_id = mt.id AND tp.firm_user_id = $${params.length} AND tp.archived_at IS NULL
              )
            )
          )`;
    }

    const { rows: threads } = await pool.query(
      `SELECT
         mt.id, mt.subject, mt.status, mt.category, mt.last_message_at, mt.created_at,
         mt.person_id, mt.staff_user_id,
         p.first_name, p.last_name, p.email,
         ${staffArchiveSelectSql},
         (SELECT body FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       JOIN thread_companies tc ON tc.thread_id = mt.id
       WHERE mt.firm_id = $1 AND tc.company_id = $2
       ${staffScopeSql}
       ORDER BY mt.last_message_at DESC`,
      params
    );

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      person: { id: t.person_id, firstName: t.first_name, lastName: t.last_name, email: t.email },
      staffUserId: t.staff_user_id,
      isArchived: showArchived,
      archivedAt: t.archived_for_user_at,
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
    })));
  } catch (err) {
    console.error('[GET /messages/company/:companyId] error:', err);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

async function getFirmDocumentForAttachmentPreview({ firmId, documentId }) {
  const { rows } = await pool.query(
    `SELECT d.id, d.s3_key, d.s3_bucket, d.firm_id, d.display_name, d.mime_type
     FROM documents d
     WHERE d.id = $1 AND d.firm_id = $2
       AND EXISTS (
         SELECT 1
         FROM message_attachments ma
         JOIN messages m ON m.id = ma.message_id
         JOIN message_threads mt ON mt.id = m.thread_id
         WHERE ma.document_id = d.id AND mt.firm_id = d.firm_id
       )`,
    [documentId, firmId]
  );
  return rows[0] || null;
}

function isPreviewableMessageImage(doc) {
  const type = String(doc?.mime_type || '').toLowerCase();
  const name = String(doc?.display_name || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
}

// ── GET /messages/attachments/:documentId/download ────────────────────────────
router.get('/attachments/:documentId/download', async (req, res) => {
  const firmId = req.firm.id;
  const documentId = parseInt(req.params.documentId);

  try {
    const doc = await getFirmDocumentForAttachmentPreview({ firmId, documentId });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const url = await getSignedDownloadUrl({ key: doc.s3_key, bucket: doc.s3_bucket, filename: doc.display_name });
    res.json({ url, file_name: doc.display_name });
  } catch (err) {
    console.error('[GET /messages/attachments/:documentId/download] error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ── GET /messages/attachments/:documentId/preview ─────────────────────────────
// Authenticated image preview proxy for Inbox thumbnails. Downloads still use the
// signed-url endpoint above; thumbnails use a short-lived blob in the browser so
// broken/cross-origin image tags do not expose or cache direct S3 URLs.
router.get('/attachments/:documentId/preview', async (req, res) => {
  const firmId = req.firm.id;
  const documentId = parseInt(req.params.documentId);

  try {
    const doc = await getFirmDocumentForAttachmentPreview({ firmId, documentId });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!isPreviewableMessageImage(doc)) return res.status(415).json({ error: 'Attachment cannot be previewed' });

    const buffer = await downloadFile({ key: doc.s3_key, bucket: doc.s3_bucket });
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  } catch (err) {
    console.error('[GET /messages/attachments/:documentId/preview] error:', err);
    res.status(500).json({ error: 'Failed to load attachment preview' });
  }
});

// ── DELETE /messages/message/:messageId ──────────────────────────────────────
// Staff can delete their own messages only — must be before /:threadId wildcard
router.delete('/message/:messageId', async (req, res) => {
  const firmId = req.firm.id;
  const staffId = req.firm.userId;
  const messageId = parseInt(req.params.messageId);

  try {
    const { rows } = await pool.query(
      `SELECT m.id FROM messages m
       JOIN message_threads mt ON mt.id = m.thread_id
       WHERE m.id = $1 AND m.sender_id = $2 AND m.sender_type = 'staff' AND mt.firm_id = $3
         AND m.removed_at IS NULL`,
      [messageId, staffId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Message not found or not yours' });

    // Soft-remove only. Physical deletes are forbidden for compliance retention.
    await pool.query(
      `UPDATE messages
       SET removed_at = NOW(),
           removed_by_staff_user_id = $2,
           removal_reason = 'staff_removed',
           body = COALESCE(body, '')
       WHERE id = $1`,
      [messageId, staffId]
    );
    await archiveClientMessageRemoved({ firmId, messageId, removedByStaffUserId: staffId });

    res.json({ ok: true, softRemoved: true });
  } catch (err) {
    console.error('[DELETE /messages/message/:messageId] error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to remove message' });
  }
});


// ── GET /messages/document-picker ────────────────────────────────────────────
router.get('/document-picker', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = req.query.thread_id ? parseInt(req.query.thread_id, 10) : null;
  const personId = req.query.person_id ? parseInt(req.query.person_id, 10) : null;
  const companyId = req.query.company_id ? parseInt(req.query.company_id, 10) : null;

  try {
    let scope = null;
    let scopeType = null;
    if (threadId) {
      const { rows } = await pool.query(
        `SELECT mt.id AS thread_id, p.id AS person_id, p.relationship_id, NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS person_name, r.name AS relationship_name
         FROM message_threads mt
         JOIN people p ON p.id = mt.person_id AND p.firm_id = mt.firm_id
         LEFT JOIN relationships r ON r.id = p.relationship_id
         WHERE mt.id = $1 AND mt.firm_id = $2`,
        [threadId, firmId]
      );
      scope = rows[0] || null;
      scopeType = 'person';
    } else if (personId) {
      const { rows } = await pool.query(
        `SELECT p.id AS person_id, p.relationship_id, NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS person_name, r.name AS relationship_name
         FROM people p LEFT JOIN relationships r ON r.id = p.relationship_id
         WHERE p.id = $1 AND p.firm_id = $2`,
        [personId, firmId]
      );
      scope = rows[0] || null;
      scopeType = 'person';
    } else if (companyId) {
      const { rows } = await pool.query(
        `SELECT c.id AS company_id, c.relationship_id, c.company_name, r.name AS relationship_name
         FROM companies c LEFT JOIN relationships r ON r.id = c.relationship_id
         WHERE c.id = $1 AND c.firm_id = $2 AND c.archived_at IS NULL`,
        [companyId, firmId]
      );
      scope = rows[0] || null;
      scopeType = 'company';
    }
    if (!scope) return res.status(404).json({ error: 'Document scope not found' });

    const params = [firmId];
    let accessWhere;
    if (scopeType === 'company') {
      params.push(scope.company_id);
      accessWhere = `d.owner_type = 'company' AND d.owner_id = $2`;
    } else {
      params.push(scope.person_id);
      accessWhere = `(
        (d.owner_type = 'person' AND d.owner_id = $2)
        OR (d.owner_type = 'company' AND d.owner_id IN (SELECT company_id FROM person_company_access WHERE person_id = $2))
      )`;
    }

    const { rows } = await pool.query(
      `SELECT d.id, d.owner_type, d.owner_id, d.year, d.doc_type, d.display_name, d.mime_type, d.size_bytes,
              d.folder_section, d.folder_category, d.created_at,
              NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS person_name,
              c.company_name
       FROM documents d
       LEFT JOIN people p ON d.owner_type = 'person' AND p.id = d.owner_id AND p.firm_id = d.firm_id
       LEFT JOIN companies c ON d.owner_type = 'company' AND c.id = d.owner_id AND c.firm_id = d.firm_id
       WHERE d.firm_id = $1
         AND (${accessWhere})
         AND (d.owner_type != 'company' OR c.archived_at IS NULL)
       ORDER BY COALESCE(c.company_name, p.last_name, p.first_name, d.owner_type), d.year DESC NULLS LAST, d.created_at DESC`,
      params
    );

    const sourceMap = new Map();
    for (const row of rows) {
      const key = `${row.owner_type}:${row.owner_id}`;
      if (!sourceMap.has(key)) {
        sourceMap.set(key, {
          key,
          ownerType: row.owner_type,
          ownerId: row.owner_id,
          label: row.owner_type === 'company' ? (row.company_name || 'Company') : (row.person_name || 'Person'),
          documents: [],
        });
      }
      sourceMap.get(key).documents.push(documentPickerDto(row));
    }

    res.json({
      scope: {
        relationshipId: scope.relationship_id,
        relationshipName: scope.relationship_name || null,
        personId: scope.person_id || null,
        personName: scope.person_name || null,
        companyId: scope.company_id || null,
        companyName: scope.company_name || null,
      },
      sources: Array.from(sourceMap.values()).filter(s => s.documents.length > 0),
    });
  } catch (err) {
    console.error('[GET /messages/document-picker] error:', err);
    res.status(500).json({ error: 'Failed to load client documents' });
  }
});

// ── GET /messages/client-search — find clients to message from the inbox ─────
router.get('/client-search', async (req, res) => {
  const firmId = req.firm.id;
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json([]);

  try {
    const userId = await currentFirmUserId(req);
    const like = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
    const { rows } = await pool.query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.phone,
              r.name AS relationship_name,
              t.id AS thread_id,
              (t.staff_archived_at IS NOT NULL OR t.status = 'archived') AS thread_archived
         FROM people p
         LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = p.firm_id
         LEFT JOIN LATERAL (
           SELECT mt.id, mt.staff_archived_at, mt.status
             FROM message_threads mt
            WHERE mt.firm_id = p.firm_id AND mt.person_id = p.id
              AND mt.staff_user_id = $3
              AND mt.category IS DISTINCT FROM 'internal'
            ORDER BY mt.last_message_at DESC NULLS LAST
            LIMIT 1
         ) t ON true
        WHERE p.firm_id = $1
          AND (
            p.first_name ILIKE $2 OR p.last_name ILIKE $2
            OR (p.first_name || ' ' || p.last_name) ILIKE $2
            OR p.email ILIKE $2
            OR COALESCE(p.spouse_name, '') ILIKE $2
            OR COALESCE(r.name, '') ILIKE $2
          )
        ORDER BY p.last_name, p.first_name
        LIMIT 8`,
      [firmId, like, userId || 0]
    );
    res.json(rows.map(row => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email || '',
      phone: row.phone || '',
      relationshipName: row.relationship_name || '',
      threadId: row.thread_id || null,
      threadArchived: row.thread_id ? row.thread_archived === true : false,
    })));
  } catch (err) {
    console.error('[GET /messages/client-search] error:', err);
    res.status(500).json({ error: 'Failed to search clients' });
  }
});

// ── GET /messages/:threadId ───────────────────────────────────────────────────
router.get('/:threadId', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);

  try {
    // Resolve caller's userId for participant check
    let callerUserId = req.firm.userId;
    if (!callerUserId) {
      try { const { rows: ur } = await pool.query('SELECT id FROM firm_users WHERE firm_id=$1 AND email=$2 LIMIT 1', [firmId, req.firm.email]); if (ur[0]) callerUserId = ur[0].id; } catch(e) {}
    }
    const { rows: threadRows } = await pool.query(
      `SELECT mt.*, p.first_name, p.last_name, p.email, p.phone,
              r.name AS relationship_name,
              fu.name as staff_name, fu.display_name as staff_display_name,
              fwd.forwarded_by_name, fwd.forwarded_note, fwd.forwarded_at,
              (tp.id IS NOT NULL AND mt.staff_user_id IS DISTINCT FROM $3) as is_participant_check,
              CASE
                WHEN mt.staff_user_id IS NOT DISTINCT FROM $3
                  THEN (mt.staff_archived_at IS NOT NULL OR mt.status = 'archived')
                ELSE (tp.id IS NOT NULL AND tp.archived_at IS NOT NULL)
              END AS is_archived_for_caller,
              (SELECT COUNT(*) > 0 FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.message_type = 'task') as has_task_messages
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN relationships r ON r.id = p.relationship_id
       LEFT JOIN firm_users fu ON fu.id = mt.staff_user_id
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $3
       LEFT JOIN LATERAL (
         SELECT COALESCE(NULLIF(fu2.display_name, ''), fu2.name, fu2.email) AS forwarded_by_name,
                mtf.note AS forwarded_note,
                mtf.created_at AS forwarded_at
         FROM message_thread_forwards mtf
         LEFT JOIN firm_users fu2 ON fu2.id = mtf.forwarded_by_id
         WHERE mtf.thread_id = mt.id AND mtf.firm_id = mt.firm_id AND mtf.forwarded_to_id = mt.staff_user_id
         ORDER BY mtf.created_at DESC
         LIMIT 1
       ) fwd ON TRUE
       WHERE mt.id = $1 AND mt.firm_id = $2`,
      [threadId, firmId, callerUserId || 0]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    const thread = threadRows[0];

    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.thread_id, m.sender_type, m.sender_id, m.body,
              m.is_internal, m.message_type, m.created_at, m.read_at,
              m.channel, m.provider_status,
              COALESCE(m.is_emma_draft, false) AS is_emma_draft
       FROM messages m
       WHERE m.thread_id = $1
         AND m.removed_at IS NULL
       ORDER BY m.created_at ASC`,
      [threadId]
    );

    if (!req.firm.supportSession) {
      await pool.query(
        `UPDATE messages SET read_at = NOW()
         WHERE thread_id = $1 AND sender_type = 'client' AND read_at IS NULL`,
        [threadId]
      );

      await pool.query(
        `DELETE FROM message_mentions mm
         USING messages m
         WHERE mm.message_id = m.id AND m.thread_id = $1 AND mm.firm_user_id = $2`,
        [threadId, req.firm.userId]
      ).catch(() => {});
    }

    const { rows: firmUsers } = await pool.query(
      'SELECT id, name, display_name FROM firm_users WHERE firm_id = $1',
      [firmId]
    );
    const userMap = {};
    for (const u of firmUsers) {
      userMap[u.id] = u.display_name || u.name || 'Staff';
    }

    const msgIds = msgs.map(m => m.id);
    const attachmentMap = {};
    if (msgIds.length > 0) {
      const { rows: attRows } = await pool.query(
        `SELECT ma.message_id, ma.id, d.display_name, d.mime_type, d.size_bytes, ma.document_id
         FROM message_attachments ma
         JOIN documents d ON d.id = ma.document_id
         WHERE ma.message_id = ANY($1)`,
        [msgIds]
      );
      for (const att of attRows) {
        if (!attachmentMap[att.message_id]) attachmentMap[att.message_id] = [];
        attachmentMap[att.message_id].push({
          id: att.id,
          documentId: att.document_id,
          displayName: att.display_name,
          mimeType: att.mime_type,
          sizeBytes: att.size_bytes,
        });
      }
    }

    const messages = msgs.map(m => ({
      id: m.id,
      senderType: m.sender_type,
      senderId: m.sender_id,
      senderName: m.sender_type === 'staff' ? (userMap[m.sender_id] || 'Staff') :
                  m.sender_type === 'client' ? `${thread.first_name} ${thread.last_name}` : 'Agent',
      body: m.body,
      isInternal: m.is_internal,
      isEmmaDraft: m.is_emma_draft || false,
      messageType: m.message_type || 'message',
      channel: m.channel || 'portal',
      providerStatus: m.provider_status || '',
      createdAt: m.created_at,
      readAt: m.read_at,
      attachments: attachmentMap[m.id] || [],
    }));
    const latestClientMessage = [...msgs].reverse().find(
      m => m.sender_type === 'client' && !m.is_internal
    );
    const preferredReplyChannel = latestClientMessage?.channel === 'sms' ? 'sms' : 'portal';

    const { rows: pendingDrafts } = await pool.query(
      `SELECT md.id, md.draft_body, md.confidence, md.agent_notes, md.created_at, ac.agent_name
       FROM message_drafts md
       LEFT JOIN agent_connections ac ON ac.id = md.agent_connection_id
       WHERE md.firm_id = $1 AND md.thread_id = $2 AND md.status = 'pending'
       ORDER BY md.created_at DESC`,
      [firmId, threadId]
    );

    res.json({
      id: thread.id,
      subject: thread.subject,
      status: thread.status,
      category: thread.category,
      hasTaskMessages: thread.has_task_messages === true || thread.has_task_messages === 'true',
      staffUserId: thread.staff_user_id,
      isParticipant: thread.is_participant_check || false,
      isArchived: thread.is_archived_for_caller || false,
      staffName: thread.staff_display_name || thread.staff_name || null,
      forwardedByName: thread.forwarded_by_name || null,
      forwardedNote: thread.forwarded_note || null,
      forwardedAt: thread.forwarded_at || null,
      lastMessageAt: thread.last_message_at,
      createdAt: thread.created_at,
      person: {
        id: thread.person_id,
        firstName: thread.first_name,
        lastName: thread.last_name,
        email: thread.email,
        phone: thread.phone || null,
        relationshipName: thread.relationship_name || null,
      },
      preferredReplyChannel,
      messages,
      pendingDrafts: pendingDrafts.map(d => ({
        id: d.id,
        draftBody: d.draft_body,
        confidence: d.confidence,
        agentNotes: d.agent_notes,
        agentName: d.agent_name || null,
        createdAt: d.created_at,
      })),
    });
  } catch (err) {
    console.error('[GET /messages/:threadId] error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// ── POST /messages — create thread + first message ───────────────────────────
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 LIMIT 1', [firmId, req.firm.email]);
      if (rows[0]) userId = rows[0].id;
    } catch(e) { /* silent */ }
  }
  const { person_id, staff_user_id, subject, body, is_internal } = req.body;
  const initialBody = String(body || '').replace(/^\n+|\n+$/g, '');
  const documentIds = parseDocumentIds(req.body.document_ids || req.body.documentIds);

  if (!person_id || (!initialBody && documentIds.length === 0)) {
    return res.status(400).json({ error: 'person_id and message body or selected client document are required' });
  }

  // staff_user_id required
  const staffId = parseInt(staff_user_id) || userId;
  if (!staffId) {
    return res.status(400).json({ error: 'staff_user_id is required' });
  }

  try {
    // Verify person belongs to this firm
    const { rows: personRows } = await pool.query(
      'SELECT id, first_name, last_name, email FROM people WHERE id = $1 AND firm_id = $2',
      [person_id, firmId]
    );
    if (!personRows[0]) return res.status(404).json({ error: 'Person not found' });

    // Validate staff_user_id belongs to this firm
    const { rows: staffRows } = await pool.query(
      'SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2',
      [staffId, firmId]
    );
    if (!staffRows[0]) return res.status(404).json({ error: 'Staff user not found' });

    // Reuse the per-client/per-staff stream even if the advisor previously hid it.
    const { rows: existingRows } = await pool.query(
      `SELECT id FROM message_threads
       WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3
         AND category IS DISTINCT FROM 'internal'
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 1`,
      [person_id, staffId, firmId]
    );

    let threadId;
    if (existingRows.length > 0) {
      threadId = existingRows[0].id;
    } else {
      const { rows: threadRows } = await pool.query(
        `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, last_message_at)
         VALUES ($1, $2, $3, $4, 'open', NOW())
         RETURNING id`,
        [firmId, person_id, staffId, subject || '']
      );
      threadId = threadRows[0].id;
    }

    // Create message
    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'staff', $2, $3, $4)
       RETURNING id`,
      [threadId, userId, initialBody, is_internal ? true : false]
    );
    const messageId = msgRows[0].id;

    if (documentIds.length > 0) {
      await attachExistingDocuments({ firmId, threadId, messageId, documentIds });
    }
    await archiveClientMessageCreatedFailClosed({ firmId, messageId, requestedByStaffUserId: userId });

    // Update last_message_at
    await pool.query(
      `UPDATE message_threads SET status = 'open', staff_archived_at = NULL, last_message_at = NOW() WHERE id = $1`,
      [threadId]
    );

    if (initialBody) setImmediate(() => applyClassification(threadId, firmId, person_id, initialBody));

    const pusher = req.app.get('pusher');
    if (pusher) {
      pusher.trigger(`private-firm-${firmId}`, 'thread-new', { threadId, personId: person_id });
    }

    if (!is_internal) {
      const { rows: firmRows } = await pool.query('SELECT name FROM firms WHERE id = $1', [firmId]);
      scheduleClientNotification({
        threadId,
        personId: personRows[0].id,
        toEmail: personRows[0].email,
        toName: `${personRows[0].first_name} ${personRows[0].last_name}`,
        firmName: firmRows[0]?.name,
        firmId,
        messagePreview: initialBody ? initialBody.trim() : null,
        messageId,
      });

      setImmediate(() => {
        sendClientMobilePush({
          firmId,
          personId: person_id,
          type: 'message',
          title: 'New secure message',
          body: initialBody || 'You have a new secure message from your firm.',
          data: { threadId, messageId },
        });
      });
    }

    res.status(201).json({ ok: true, threadId, messageId });
  } catch (err) {
    console.error('[POST /messages] error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create thread' });
  }
});

// ── POST /messages/:threadId/reply ───────────────────────────────────────────
router.post('/:threadId/reply', upload.array('files', 8), async (req, res) => {
  const firmId = req.firm.id;
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 LIMIT 1', [firmId, req.firm.email]);
      if (rows[0]) userId = rows[0].id;
    } catch(e) { /* silent */ }
  }
  const threadId = parseInt(req.params.threadId);
  const body = String(req.body.body || '').replace(/^\n+|\n+$/g, '');
  const is_internal = req.body.is_internal === 'true';
  const hasMentions = body && /@[A-Za-z]/.test(body);
  const effectiveInternal = is_internal || hasMentions;
  const agentDraftId = req.body.agent_draft_id ? parseInt(req.body.agent_draft_id, 10) : null;
  const agentDraftStatus = ['accepted', 'edited_sent'].includes(req.body.agent_draft_status) ? req.body.agent_draft_status : null;
  const files = req.files || [];
  const documentIds = parseDocumentIds(req.body.document_ids || req.body.documentIds);

  if (!body && files.length === 0 && documentIds.length === 0) {
    return res.status(400).json({ error: 'Message body, file, or selected client document is required' });
  }

  try {
    const { rows: threadRows } = await pool.query(
      `SELECT mt.*, p.first_name, p.last_name, p.email, f.name AS firm_name
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       JOIN firms f ON f.id = mt.firm_id
       WHERE mt.id = $1 AND mt.firm_id = $2`,
      [threadId, firmId]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });
    let thread = threadRows[0];
    let sendThreadId = threadId;

    let isActiveParticipant = false;
    let isTransferRecipient = false;
    if (!effectiveInternal && thread.staff_user_id !== userId && userId) {
      const { rows: participantRows } = await pool.query(
        `SELECT 1
         FROM thread_participants
         WHERE thread_id = $1 AND firm_user_id = $2 AND firm_id = $3 AND archived_at IS NULL
         LIMIT 1`,
        [threadId, userId, firmId]
      );
      isActiveParticipant = !!participantRows[0];

      const { rows: transferRows } = await pool.query(
        `SELECT forwarded_to_id
         FROM message_thread_forwards
         WHERE thread_id = $1 AND firm_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [threadId, firmId]
      );
      isTransferRecipient = Number(transferRows[0]?.forwarded_to_id || 0) === Number(userId);
      if (isTransferRecipient) {
        await pool.query(
          `UPDATE message_threads
           SET staff_user_id = $1, assigned_to = $1, staff_archived_at = NULL, status = 'open'
           WHERE id = $2 AND firm_id = $3`,
          [userId, threadId, firmId]
        );
        await pool.query(
          `DELETE FROM thread_participants
           WHERE thread_id = $1 AND firm_user_id = $2 AND firm_id = $3`,
          [threadId, userId, firmId]
        );
        thread.staff_user_id = userId;
      }
    }

    // Authorization: internal notes can be posted by anyone in the firm.
    // Shared participants may now reply to the client in the original thread.
    // External replies from a stale/foreign CRM thread still redirect to the
    // sender's own per-client thread instead of leaking into another staff inbox.
    if (!effectiveInternal && thread.staff_user_id && thread.staff_user_id !== userId && !isActiveParticipant && !isTransferRecipient) {
      if (!userId) return res.status(401).json({ error: 'Staff user could not be resolved' });

      const { rows: ownThreadRows } = await pool.query(
        `SELECT mt.*, p.first_name, p.last_name, p.email, f.name AS firm_name
         FROM message_threads mt
         JOIN people p ON p.id = mt.person_id
         JOIN firms f ON f.id = mt.firm_id
         WHERE mt.firm_id = $1
           AND mt.person_id = $2
           AND mt.staff_user_id = $3
          AND mt.category IS DISTINCT FROM 'internal'
         ORDER BY mt.last_message_at DESC
         LIMIT 1`,
        [firmId, thread.person_id, userId]
      );

      if (ownThreadRows[0]) {
        thread = ownThreadRows[0];
      } else {
        const { rows: createdRows } = await pool.query(
          `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, last_message_at)
           VALUES ($1, $2, $3, $4, 'open', NOW())
           RETURNING *`,
          [firmId, thread.person_id, userId, thread.subject || '']
        );
        thread = { ...thread, ...createdRows[0] };
      }
      sendThreadId = thread.id;
    }

    // Auto-assign thread to replying user if unassigned
    if (!thread.staff_user_id && userId) {
      await pool.query('UPDATE message_threads SET staff_user_id = $1, assigned_to = $1, staff_archived_at = NULL WHERE id = $2', [userId, sendThreadId]);
      thread.staff_user_id = userId;
    }

    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'staff', $2, $3, $4)
       RETURNING id, created_at`,
      [sendThreadId, userId, body || '', effectiveInternal]
    );
    const messageId = msgRows[0].id;

    if (agentDraftId && agentDraftStatus && !effectiveInternal) {
      await pool.query(
        `UPDATE message_drafts md
         SET status = $4, updated_at = NOW()
         WHERE md.id = $1 AND md.firm_id = $2 AND md.thread_id = $3 AND md.status = 'pending'`,
        [agentDraftId, firmId, sendThreadId, agentDraftStatus]
      );
    }

    if (body) {
      const mentionPattern = /@([A-Za-z]+(?: [A-Za-z]+)?)/g;
      let mentionMatch;
      while ((mentionMatch = mentionPattern.exec(body)) !== null) {
        const mentionedName = mentionMatch[1];
        const { rows: mentioned } = await pool.query(
          `SELECT id FROM firm_users WHERE firm_id=$1 AND (name ILIKE $2 OR display_name ILIKE $2) LIMIT 1`,
          [firmId, mentionedName]
        );
        if (mentioned.length) {
          const mentionedUserId = mentioned[0].id;
          await pool.query(
            `INSERT INTO message_mentions (message_id, firm_user_id, firm_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [messageId, mentionedUserId, firmId]
          ).catch(() => {});
          // Auto-share thread with mentioned staff member (skip if they're the owner)
          if (mentionedUserId !== thread.staff_user_id) {
            await pool.query(
              `INSERT INTO thread_participants (thread_id, firm_user_id, added_by_id, firm_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (thread_id, firm_user_id) DO UPDATE SET archived_at = NULL, added_by_id = $3, added_at = NOW()`,
              [sendThreadId, mentionedUserId, userId, firmId]
            ).catch(() => {});
          }
        }
      }
    }

    if (documentIds.length > 0) {
      await attachExistingDocuments({ firmId, threadId: sendThreadId, messageId, documentIds });
    }

    if (files.length > 0) {
      const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
      const year = String(new Date().getFullYear());
      for (const f of files) {
        const key = buildKey({
          firmId,
          ownerType: 'person',
          ownerId: thread.person_id,
          year,
          docType: 'message_docs',
          filename: f.originalname,
        });
        await uploadFile({ firmId: firmId, buffer: f.buffer, key, mimeType: f.mimetype, bucket });
        const { rows: docRows } = await pool.query(
          `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type, size_bytes,
            s3_key, s3_bucket, year, folder_section, folder_category, uploaded_by_type, uploaded_by_id,
            is_delivered, created_at)
           VALUES ($1, 'person', $2, 'other', $3, $4, $5, $6, $7, $8, 'firm_uploaded', 'message_docs', 'staff', $9, true, NOW())
           RETURNING id`,
          [firmId, thread.person_id, f.originalname, f.mimetype, f.size, key, bucket, year, userId]
        );
        await pool.query(
          'INSERT INTO message_attachments (message_id, document_id) VALUES ($1, $2)',
          [messageId, docRows[0].id]
        );
      }
    }

    await archiveClientMessageCreatedFailClosed({ firmId, messageId, requestedByStaffUserId: userId });

    if (!effectiveInternal) {
      await pool.query(
        `UPDATE message_threads SET status = 'open', staff_archived_at = NULL, last_message_at = NOW() WHERE id = $1`,
        [sendThreadId]
      );

      scheduleClientNotification({
        threadId: sendThreadId,
        personId: thread.person_id,
        toEmail: thread.email,
        toName: `${thread.first_name} ${thread.last_name}`,
        firmName: thread.firm_name,
        firmId,
        messagePreview: body ? body.trim() : null,
        messageId,
      });

      setImmediate(() => {
        sendClientMobilePush({
          firmId,
          personId: thread.person_id,
          type: 'message',
          title: 'New secure message',
          body: body || 'You have a new secure message from your firm.',
          data: { threadId: sendThreadId, messageId },
        });
      });
    }

    const pusher = req.app.get('pusher');
    if (pusher && !effectiveInternal) {
      pusher.trigger([`private-firm-${firmId}`, `private-portal-${firmId}-${thread.person_id}`], 'message-new', { threadId: sendThreadId, senderType: 'staff' });
    } else if (pusher && effectiveInternal) {
      pusher.trigger(`private-firm-${firmId}`, 'message-new', { threadId: sendThreadId, senderType: 'staff' });
    }

    const { rows: senderRows } = await pool.query(
      "SELECT COALESCE(NULLIF(display_name, ''), name, email, $3) AS sender_name FROM firm_users WHERE firm_id = $1 AND id = $2 LIMIT 1",
      [firmId, userId, 'Staff']
    );
    const { rows: replyAttRows } = await pool.query(
      `SELECT ma.id, ma.document_id, d.display_name, d.mime_type, d.size_bytes
       FROM message_attachments ma
       JOIN documents d ON d.id = ma.document_id
       WHERE ma.message_id = $1
       ORDER BY ma.id ASC`,
      [messageId]
    );

    res.json({
      ok: true,
      threadId: sendThreadId,
      messageId,
      message: {
        id: messageId,
        senderType: 'staff',
        senderId: userId,
        senderName: senderRows[0]?.sender_name || 'Staff',
        body: body || '',
        isInternal: effectiveInternal,
        messageType: 'message',
        createdAt: msgRows[0].created_at,
        attachments: replyAttRows.map(att => ({
          id: att.id,
          documentId: att.document_id,
          displayName: att.display_name,
          mimeType: att.mime_type,
          sizeBytes: att.size_bytes,
        })),
      },
    });
  } catch (err) {
    console.error('[POST /messages/:threadId/reply] error:', err.message, err.stack?.split('\n')[1]);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to send reply' });
  }
});

// ── POST /messages/:threadId/share — add a participant (called on @mention) ──
router.post('/:threadId/share', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  let userId = req.firm.userId;
  if (!userId) {
    try { const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id=$1 AND email=$2 LIMIT 1', [firmId, req.firm.email]); if (rows[0]) userId = rows[0].id; } catch(e) {}
  }
  const { staff_user_id } = req.body;
  if (!staff_user_id) return res.status(400).json({ error: 'staff_user_id required' });

  try {
    // Verify thread belongs to this firm
    const { rows: threadRows } = await pool.query('SELECT id, staff_user_id FROM message_threads WHERE id=$1 AND firm_id=$2', [threadId, firmId]);
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });
    // Don't add the owner as a participant
    if (threadRows[0].staff_user_id === parseInt(staff_user_id)) return res.json({ ok: true, skipped: true });

    await pool.query(
      `INSERT INTO thread_participants (thread_id, firm_user_id, added_by_id, firm_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (thread_id, firm_user_id) DO UPDATE SET archived_at = NULL, added_by_id = $3, added_at = NOW()`,
      [threadId, staff_user_id, userId, firmId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /messages/:threadId/share] error:', err);
    res.status(500).json({ error: 'Failed to share thread' });
  }
});

// ── POST /messages/:threadId/forward — transfer thread ownership to another staff member ──
router.post('/:threadId/forward', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const userId = await currentFirmUserId(req);
  const targetStaffId = parseInt(req.body.staff_user_id, 10);
  const note = String(req.body.note || '').trim();
  const keepForwarderAsParticipant = req.body.keep_forwarder_as_participant !== false;

  if (!userId) return res.status(401).json({ error: 'Staff user could not be resolved' });
  if (!targetStaffId) return res.status(400).json({ error: 'staff_user_id required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: threadRows } = await client.query(
      `SELECT id, staff_user_id, person_id, subject
       FROM message_threads
       WHERE id = $1 AND firm_id = $2
       FOR UPDATE`,
      [threadId, firmId]
    );
    const thread = threadRows[0];
    if (!thread) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Thread not found' });
    }

    const { rows: targetRows } = await client.query(
      `SELECT id, COALESCE(NULLIF(display_name, ''), name, email) AS name
       FROM firm_users
       WHERE id = $1 AND firm_id = $2 AND archived_at IS NULL`,
      [targetStaffId, firmId]
    );
    const target = targetRows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Target staff user not found' });
    }

    const { rows: forwarderRows } = await client.query(
      `SELECT id, COALESCE(NULLIF(display_name, ''), name, email) AS name
       FROM firm_users
       WHERE id = $1 AND firm_id = $2`,
      [userId, firmId]
    );
    const forwarderName = forwarderRows[0]?.name || 'Staff';

    if (thread.staff_user_id === targetStaffId) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, skipped: true });
    }

    await client.query(
      `INSERT INTO message_thread_forwards
         (firm_id, thread_id, forwarded_by_id, forwarded_to_id, previous_staff_user_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [firmId, threadId, userId, targetStaffId, thread.staff_user_id || null, note]
    );

    await client.query(
      `UPDATE message_threads
       SET staff_user_id = $1, assigned_to = $1, staff_archived_at = NULL, status = 'open', last_message_at = NOW()
       WHERE id = $2 AND firm_id = $3`,
      [targetStaffId, threadId, firmId]
    );

    if (keepForwarderAsParticipant && userId !== targetStaffId) {
      await client.query(
        `INSERT INTO thread_participants (thread_id, firm_user_id, added_by_id, firm_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (thread_id, firm_user_id)
         DO UPDATE SET archived_at = NULL, added_by_id = $3, added_at = NOW()`,
        [threadId, userId, userId, firmId]
      );
    }

    await client.query(
      `DELETE FROM thread_participants
       WHERE thread_id = $1 AND firm_user_id = $2 AND firm_id = $3`,
      [threadId, targetStaffId, firmId]
    );

    const body = note
      ? `Transferred by ${forwarderName} to ${target.name}: ${note}`
      : `Transferred by ${forwarderName} to ${target.name}`;
    const { rows: systemMessageRows } = await client.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal, is_system_message, message_type)
       VALUES ($1, 'staff', $2, $3, true, true, 'system')
       RETURNING id`,
      [threadId, userId, body]
    );

    await client.query('COMMIT');
    await archiveClientMessageCreatedFailClosed({ firmId, messageId: systemMessageRows[0].id, requestedByStaffUserId: userId });
    res.json({ ok: true, threadId, forwardedToId: targetStaffId, forwardedToName: target.name, forwardedByName: forwarderName });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /messages/:threadId/forward] error:', err);
    res.status(500).json({ error: 'Failed to forward thread' });
  } finally {
    client.release();
  }
});

// ── PUT /messages/:threadId/archive — hide a thread from the current staff inbox ─
// Owners hide their assigned thread from staff surfaces only. The client portal
// stream remains readable and future client/staff messages unhide the thread.
// Participants remove themselves from the shared thread.
router.put('/:threadId/archive', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  let userId = req.firm.userId;
  if (!userId) {
    try { const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id=$1 AND email=$2 LIMIT 1', [firmId, req.firm.email]); if (rows[0]) userId = rows[0].id; } catch(e) {}
  }

  try {
    const { rows: threadRows } = await pool.query('SELECT staff_user_id FROM message_threads WHERE id=$1 AND firm_id=$2', [threadId, firmId]);
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    if (!threadRows[0].staff_user_id || threadRows[0].staff_user_id === userId) {
      await pool.query(
        `UPDATE message_threads SET staff_archived_at = NOW() WHERE id = $1 AND firm_id = $2`,
        [threadId, firmId]
      );
    } else {
      // Participant: just remove themselves. If they are not actually a participant, return forbidden.
      const { rowCount } = await pool.query(
        `UPDATE thread_participants SET archived_at = NOW() WHERE thread_id = $1 AND firm_user_id = $2 AND archived_at IS NULL`,
        [threadId, userId]
      );
      if (rowCount === 0) return res.status(403).json({ error: 'Only the assigned staff member can archive this thread' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/archive] error:', err);
    res.status(500).json({ error: 'Failed to archive thread' });
  }
});

// ── PUT /messages/:threadId/restore — return a thread to the current staff inbox ─
router.put('/:threadId/restore', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);

  try {
    const userId = await currentFirmUserId(req);
    const { rows: threadRows } = await pool.query(
      'SELECT staff_user_id FROM message_threads WHERE id = $1 AND firm_id = $2',
      [threadId, firmId]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    if (!threadRows[0].staff_user_id || threadRows[0].staff_user_id === userId) {
      await pool.query(
        `UPDATE message_threads
         SET staff_archived_at = NULL,
             status = CASE WHEN status = 'archived' THEN 'open' ELSE status END
         WHERE id = $1 AND firm_id = $2`,
        [threadId, firmId]
      );
    } else {
      const { rowCount } = await pool.query(
        `UPDATE thread_participants
         SET archived_at = NULL
         WHERE thread_id = $1 AND firm_user_id = $2 AND archived_at IS NOT NULL`,
        [threadId, userId]
      );
      if (rowCount === 0) {
        return res.status(403).json({ error: 'Only the assigned staff member or an archived participant can restore this thread' });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/restore] error:', err);
    res.status(500).json({ error: 'Failed to restore thread' });
  }
});

// ── PUT /messages/:threadId/status ───────────────────────────────────────────
router.put('/:threadId/status', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const { status } = req.body;

  const normalizedStatus = status === 'active' ? 'open' : status;
  if (!['open', 'resolved', 'archived'].includes(normalizedStatus)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const { rowCount } = await pool.query(
      'UPDATE message_threads SET status = $1 WHERE id = $2 AND firm_id = $3',
      [normalizedStatus, threadId, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Thread not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/status] error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ── POST /messages/:threadId/companies ───────────────────────────────────────
router.post('/:threadId/companies', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const { company_id } = req.body;

  if (!company_id) return res.status(400).json({ error: 'company_id is required' });

  try {
    const { rows } = await pool.query(
      'SELECT id FROM message_threads WHERE id = $1 AND firm_id = $2',
      [threadId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Thread not found' });

    await pool.query(
      `INSERT INTO thread_companies (thread_id, company_id, ai_confidence, added_by)
       VALUES ($1, $2, 1.0, 'staff')
       ON CONFLICT (thread_id, company_id) DO NOTHING`,
      [threadId, company_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /messages/:threadId/companies] error:', err);
    res.status(500).json({ error: 'Failed to add company tag' });
  }
});

// ── DELETE /messages/:threadId/companies/:companyId ──────────────────────────
router.delete('/:threadId/companies/:companyId', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const companyId = parseInt(req.params.companyId);

  try {
    const { rows } = await pool.query(
      'SELECT id FROM message_threads WHERE id = $1 AND firm_id = $2',
      [threadId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Thread not found' });

    await pool.query(
      'DELETE FROM thread_companies WHERE thread_id = $1 AND company_id = $2',
      [threadId, companyId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /messages/:threadId/companies/:companyId] error:', err);
    res.status(500).json({ error: 'Failed to remove company tag' });
  }
});

// ── DELETE /messages/message/:messageId ──────────────────────────────────────
// Staff can delete their own messages only
// ── PUT /messages/:threadId/read ─────────────────────────────────────────────
router.put('/:threadId/read', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);

  try {
    const { rows } = await pool.query(
      'SELECT id FROM message_threads WHERE id = $1 AND firm_id = $2',
      [threadId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Thread not found' });

    await pool.query(
      `UPDATE messages SET read_at = NOW()
       WHERE thread_id = $1 AND sender_type = 'client' AND read_at IS NULL`,
      [threadId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/read] error:', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// ── POST /messages/sms ───────────────────────────────────────────────────────
router.post('/sms', async (req, res) => {
  const firmId = req.firm.id;
  const { person_id, body, thread_id, agent_draft_id, agent_draft_status } = req.body;

  if (!person_id || !body || !body.trim()) {
    return res.status(400).json({ error: 'person_id and body are required' });
  }

  try {
    const userId = await currentFirmUserId(req);
    if (!userId) return res.status(401).json({ error: 'Staff user could not be resolved' });

    const { rows: people } = await pool.query(
      `SELECT id, first_name, last_name, phone, COALESCE(sms_opted_out, false) AS sms_opted_out
         FROM people WHERE id = $1 AND firm_id = $2`,
      [parseInt(person_id), firmId]
    );
    if (!people[0]) return res.status(404).json({ error: 'Person not found' });
    const person = people[0];

    if (!person.phone) {
      return res.status(400).json({ error: 'This person has no phone number on file' });
    }
    if (person.sms_opted_out) {
      return res.status(409).json({ error: 'This person has opted out of text messages' });
    }

    let useThreadId = thread_id ? parseInt(thread_id) : null;
    if (useThreadId) {
      const { rows: requestedThreads } = await pool.query(
        `SELECT id FROM message_threads
          WHERE id = $1 AND firm_id = $2 AND person_id = $3`,
        [useThreadId, firmId, person_id]
      );
      if (!requestedThreads[0]) {
        return res.status(400).json({ error: 'Thread does not belong to this person' });
      }
    }

    const { normalizePhone, saveActiveRoute } = require('../services/inboundSms');
    const phone = normalizePhone(person.phone);
    const twilioPhone = normalizePhone(process.env.TWILIO_FROM_NUMBER);
    if (!phone) return res.status(400).json({ error: 'This person has an invalid phone number' });
    if (!twilioPhone) return res.status(503).json({ error: 'Firm text messaging is not configured' });
    await pool.query(
      `UPDATE firms
          SET twilio_phone_number = $1
        WHERE id = $2 AND COALESCE(twilio_phone_number, '') = ''`,
      [twilioPhone, firmId]
    );

    // Fetch firm display name for SMS header
    const { rows: firmRows } = await pool.query(
      'SELECT display_name FROM firms WHERE id = $1',
      [firmId]
    );
    const firmName = firmRows[0]?.display_name || 'Your Advisory Firm';

    // Prepend firm name header and append opt-out footer
    const smsBody = `${firmName}: ${body.trim()}\n\nReply STOP to opt out.`;

    if (!useThreadId) {
      const { rows: threads } = await pool.query(
        `SELECT mt.id
           FROM message_threads mt
          LEFT JOIN sms_thread_routes str
            ON str.firm_id = mt.firm_id AND str.thread_id = mt.id
           AND str.client_phone = $4 AND str.twilio_phone = $5
          WHERE mt.firm_id = $1 AND mt.person_id = $2
            AND mt.category IS DISTINCT FROM 'internal'
          ORDER BY
            (mt.staff_user_id = $3) DESC,
            (str.id IS NOT NULL) DESC,
            EXISTS (
              SELECT 1 FROM messages m
               WHERE m.thread_id = mt.id
                 AND (m.channel = 'sms' OR m.body LIKE '📱 SMS sent:%' OR m.body LIKE '📱 SMS received:%')
            ) DESC,
            (mt.status = 'open') DESC,
            mt.last_message_at DESC NULLS LAST
          LIMIT 1`,
        [firmId, person_id, userId, phone, twilioPhone]
      );
      if (threads[0]) {
        useThreadId = threads[0].id;
      } else {
        const { rows: newThread } = await pool.query(
          `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, category, last_message_at)
           VALUES ($1, $2, $3, $4, 'open', 'general', NOW()) RETURNING id`,
          [firmId, person_id, userId, `Messages with ${person.first_name} ${person.last_name}`]
        );
        useThreadId = newThread[0].id;
      }
    }

    await pool.query(
      `UPDATE message_threads
          SET staff_user_id = COALESCE(staff_user_id, $1),
              assigned_to = COALESCE(assigned_to, $1),
              status = 'open',
              staff_archived_at = NULL
        WHERE id = $2 AND firm_id = $3`,
      [userId, useThreadId, firmId]
    );

    const { rows: insertedMessages } = await pool.query(
      `INSERT INTO messages
       (thread_id, sender_type, sender_id, body, channel, provider_message_id,
          provider_status, provider_from_phone, provider_to_phone, created_at)
       VALUES ($1, 'staff', $2, $3, 'sms', NULL, 'sending', $4, $5, NOW())
       RETURNING id`,
      [useThreadId, userId, body.trim(), twilioPhone, phone]
    );
    const messageId = insertedMessages[0].id;

    await archiveClientMessageCreatedFailClosed({ firmId, messageId, requestedByStaffUserId: userId });

    const statusCallback = `${APP_URL}/api/twilio/status`;
    const { sendSMS } = require('../services/twilio');
    let result;
    try {
      result = await sendSMS(phone, smsBody, { statusCallback,firmId });
      await pool.query(
        `UPDATE messages
            SET provider_message_id = $1, provider_status = $2
          WHERE id = $3`,
        [result.sid, result.status || 'queued', messageId]
      );
    } catch (sendError) {
      await pool.query(
        `UPDATE messages SET provider_status = 'failed' WHERE id = $1`,
        [messageId]
      ).catch(() => {});
      await pool.query(
        `UPDATE message_threads
            SET status = 'open', staff_archived_at = NULL, last_message_at = NOW()
          WHERE id = $1`,
        [useThreadId]
      ).catch(() => {});
      sendError.threadId = useThreadId;
      sendError.messageId = messageId;
      throw sendError;
    }

    await saveActiveRoute(pool, {
      firmId,
      personId: Number(person_id),
      threadId: useThreadId,
      clientPhone: phone,
      twilioPhone,
      direction: 'outbound',
    });

    const draftId = Number.parseInt(agent_draft_id, 10);
    const draftStatus = ['accepted', 'edited_sent'].includes(agent_draft_status)
      ? agent_draft_status
      : null;
    if (draftId && draftStatus) {
      await pool.query(
        `UPDATE message_drafts
            SET status = $1, updated_at = NOW()
          WHERE id = $2 AND firm_id = $3 AND thread_id = $4 AND status = 'pending'`,
        [draftStatus, draftId, firmId, useThreadId]
      );
    }

    await pool.query(
      `UPDATE message_threads
          SET status = 'open', staff_archived_at = NULL, last_message_at = NOW()
        WHERE id = $1`,
      [useThreadId]
    );

    const pusher = req.app.get('pusher');
    if (pusher) {
      pusher.trigger(
        [`private-firm-${firmId}`, `private-portal-${firmId}-${person_id}`],
        'message-new',
        { threadId: useThreadId, senderType: 'staff' }
      );
    }

    res.json({
      ok: true,
      sid: result.sid,
      status: result.status,
      thread_id: useThreadId,
      message_id: messageId,
    });
  } catch (err) {
    console.error('[POST /api/messages/sms] error:', err);
    res.status(err.messageId ? 502 : 500).json({
      error: err.message || 'Failed to send SMS',
      thread_id: err.threadId || null,
      message_id: err.messageId || null,
    });
  }
});

// ── POST /messages/company/:companyId/summary — AI digest of last 30 days ──────
router.post('/company/:companyId/summary', async (req, res) => {
  const firmId = req.firm.id;
  const companyId = parseInt(req.params.companyId);
  try {
    const { rows: coRows } = await pool.query(
      'SELECT company_name FROM companies WHERE id = $1 AND firm_id = $2', [companyId, firmId]
    );
    if (!coRows[0]) return res.status(404).json({ error: 'Company not found' });
    const companyName = coRows[0].company_name || 'This company';

    // Pull last 30 days of non-internal messages across all threads for this company
    const { rows: msgs } = await pool.query(`
      SELECT m.body, m.sender_type, m.created_at,
             CASE WHEN m.sender_type='staff' THEN COALESCE(NULLIF(fu.display_name, ''), fu.name, 'Staff')
                  ELSE COALESCE(p.first_name || ' ' || p.last_name, 'Client') END AS sender_name
      FROM messages m
      JOIN message_threads mt ON mt.id = m.thread_id
      JOIN thread_companies tc ON tc.thread_id = mt.id
      LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
      LEFT JOIN people p ON p.id = mt.person_id
      WHERE tc.company_id = $1 AND mt.firm_id = $2
        AND m.is_internal = false
        AND m.removed_at IS NULL
        AND m.created_at > NOW() - INTERVAL '30 days'
        AND m.body IS NOT NULL AND m.body != ''
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [companyId, firmId]);

    if (!msgs.length) return res.json({ summary: null, message: 'No messages in the last 30 days.' });

    const transcript = msgs.map(m =>
      `[${new Date(m.created_at).toLocaleDateString('en-US', {month:'short', day:'numeric'})} - ${m.sender_name}]: ${m.body.slice(0, 500)}`
    ).join('\n');

    const summary = await completeText({firmId,feature:'client-summary',maxTokens:600,prompt: `You are summarizing recent client communication for an advisor before a meeting or call.\n\nCompany: ${companyName}\n\nLast 30 days of messages:\n${transcript}\n\nWrite a concise, structured summary with these sections (only include sections that have content):\n**Recent Topics** — key subjects discussed\n**Action Items** — anything promised, requested, or outstanding\n**Documents** — any documents mentioned, sent, or requested\n**Client Mood/Concerns** — any worries, questions, or tone worth noting\n\nBe brief and actionable. No fluff.`
    });
    res.json({ summary, messageCount: msgs.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[POST /messages/company/:companyId/summary] error:', err);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

module.exports = router;
module.exports.cancelPendingNotification = cancelPendingNotification;
