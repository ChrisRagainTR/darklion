'use strict';

const { pool } = require('../db');

const GROUPING_WINDOW_MINUTES = 10;

function normalizeCategory(category) {
  if (category === 'organizer') return 'tax';
  if (category === 'tax' || category === 'bookkeeping') return category;
  return 'other';
}

function qualifiesForNotification(document) {
  return document?.uploaded_by_type === 'client'
    && document?.folder_section === 'client_uploaded'
    && document?.folder_category !== 'message_docs';
}

function groupingKey({ uploaderPersonId, document, category }) {
  return JSON.stringify([
    uploaderPersonId,
    document.owner_type,
    document.owner_id,
    category,
    document.document_folder_id || 0,
    document.folder_subcategory || '',
    document.year || '',
  ]);
}

function notificationSummary(fileCount, displayName) {
  return fileCount === 1
    ? `1 file uploaded: ${displayName || 'Document'}`
    : `${fileCount} files uploaded`;
}

async function createDocumentUploadNotification({ firmId, uploaderPersonId, document, db = pool, pusher = null }) {
  if (!firmId || !uploaderPersonId || !document?.id || !qualifiesForNotification(document)) return null;

  const category = normalizeCategory(document.folder_category);
  const groupKey = groupingKey({ uploaderPersonId, document, category });
  const client = await db.connect();
  let notification;
  let recipientIds = [];
  try {
    await client.query('BEGIN');
    // Serialize retries for the same document and first writers for the same
    // grouping bucket. Without these locks, concurrent uploads can both see no
    // existing row and create duplicate notification groups.
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [firmId, Number(document.id)]
    );
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, hashtext($2))',
      [firmId, groupKey]
    );

    const { rows: existingDocumentRows } = await client.query(
      `SELECT dnrd.notification_id
         FROM document_upload_notification_documents dnrd
         JOIN document_upload_notifications dun
           ON dun.id = dnrd.notification_id AND dun.firm_id = dnrd.firm_id
        WHERE dnrd.firm_id = $1 AND dnrd.document_id = $2
        LIMIT 1`,
      [firmId, document.id]
    );
    if (existingDocumentRows[0]) {
      await client.query('COMMIT');
      return null;
    }

    const { rows: groupedRows } = await client.query(
      `SELECT id, file_count, created_at, updated_at
         FROM document_upload_notifications
        WHERE firm_id = $1 AND grouping_key = $2
          AND updated_at >= NOW() - INTERVAL '${GROUPING_WINDOW_MINUTES} minutes'
        ORDER BY updated_at DESC
        LIMIT 1
        FOR UPDATE`,
      [firmId, groupKey]
    );

    if (groupedRows[0]) {
      // Membership belongs to the notification group, not the mutable routing
      // configuration. A follow-up upload only revives the original recipients.
      const { rows: recipientRows } = await client.query(
        `UPDATE document_upload_notification_recipients
            SET read_at = NULL, archived_at = NULL, updated_at = NOW()
          WHERE firm_id = $1 AND notification_id = $2
          RETURNING staff_user_id`,
        [firmId, groupedRows[0].id]
      );
      recipientIds = recipientRows.map(row => Number(row.staff_user_id)).sort((a, b) => a - b);
      if (!recipientIds.length) {
        await client.query('COMMIT');
        return null;
      }
      const nextCount = Number(groupedRows[0].file_count) + 1;
      const { rows } = await client.query(
        `UPDATE document_upload_notifications
            SET file_count = $1, summary = $2, updated_at = NOW()
          WHERE id = $3 AND firm_id = $4
          RETURNING id, file_count, created_at, updated_at`,
        [nextCount, notificationSummary(nextCount), groupedRows[0].id, firmId]
      );
      notification = rows[0];
    } else {
      const { rows: routeRows } = await client.query(
        `SELECT dnr.staff_user_id
           FROM document_notification_routes dnr
           JOIN firm_users fu ON fu.id = dnr.staff_user_id AND fu.firm_id = dnr.firm_id
          WHERE dnr.firm_id = $1 AND dnr.folder_category = $2
            AND fu.accepted_at IS NOT NULL AND fu.archived_at IS NULL
          ORDER BY dnr.staff_user_id`,
        [firmId, category]
      );
      recipientIds = routeRows.map(row => Number(row.staff_user_id));
      if (!recipientIds.length) {
        const fallback = await client.query(`SELECT fu.id FROM firm_users fu JOIN firm_preferences fp ON fp.firm_id=fu.firm_id
          WHERE fu.firm_id=$1 AND fu.role='owner' AND fu.archived_at IS NULL AND fu.accepted_at IS NOT NULL
            AND (fp.settings->>'notificationFallback'='owners' OR (fp.settings->>'edition'='public' AND NOT fp.settings ? 'notificationFallback'))`, [firmId]);
        recipientIds = fallback.rows.map(row => Number(row.id));
      }
      if (!recipientIds.length) {
        await client.query('COMMIT');
        return null;
      }
      const { rows } = await client.query(
        `INSERT INTO document_upload_notifications
           (firm_id, uploader_person_id, owner_type, owner_id, folder_category,
            document_folder_id, folder_subcategory, year, file_count, summary, grouping_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)
         RETURNING id, file_count, created_at, updated_at`,
        [
          firmId, uploaderPersonId, document.owner_type, document.owner_id, category,
          document.document_folder_id || null, document.folder_subcategory || '', document.year || '',
          notificationSummary(1, document.display_name), groupKey,
        ]
      );
      notification = rows[0];
      for (const staffUserId of recipientIds) {
        await client.query(
          `INSERT INTO document_upload_notification_recipients
             (notification_id, firm_id, staff_user_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (notification_id, staff_user_id) DO NOTHING`,
          [notification.id, firmId, staffUserId]
        );
      }
    }

    await client.query(
      `INSERT INTO document_upload_notification_documents (firm_id, notification_id, document_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (notification_id, document_id) DO NOTHING`,
      [firmId, notification.id, document.id]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (pusher) {
    try {
      // Firm channels are shared; recipient and document metadata stays behind
      // the recipient-scoped API and is never included in realtime events.
      await pusher.trigger(`private-firm-${firmId}`, 'document-upload-notification', { refresh: true });
    } catch (error) {
      console.error('[document-upload-notification] Pusher error (non-fatal):', error.message);
    }
  }
  return { id: Number(notification.id), category, recipientIds, fileCount: Number(notification.file_count) };
}

async function processNextDocumentUploadNotification({ db = pool, pusher = null } = {}) {
  const client = await db.connect();
  let job;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `WITH next_job AS (
         SELECT id
           FROM document_upload_notification_outbox
          WHERE (status = 'pending' AND next_attempt_at <= NOW())
             OR (status = 'processing' AND started_at < NOW() - INTERVAL '5 minutes')
          ORDER BY next_attempt_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE document_upload_notification_outbox outbox
          SET status = 'processing', attempts = attempts + 1,
              started_at = NOW(), updated_at = NOW(), last_error = NULL
         FROM next_job
        WHERE outbox.id = next_job.id
        RETURNING outbox.id, outbox.firm_id, outbox.document_id, outbox.uploader_person_id,
                  outbox.owner_type, outbox.owner_id, outbox.folder_category,
                  outbox.document_folder_id, outbox.folder_subcategory, outbox.year,
                  outbox.display_name, outbox.uploaded_by_type, outbox.folder_section,
                  outbox.attempts`,
    );
    job = rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (!job) return null;
  try {
    const snapshot = {
      document_id: Number(job.document_id),
      owner_type: job.owner_type,
      owner_id: Number(job.owner_id),
      folder_category: job.folder_category,
      document_folder_id: job.document_folder_id == null ? null : Number(job.document_folder_id),
      folder_subcategory: job.folder_subcategory || '',
      year: job.year || '',
      display_name: job.display_name || 'Document',
      uploaded_by_type: job.uploaded_by_type,
      folder_section: job.folder_section,
    };

    if (!qualifiesForNotification(job)) {
      await db.query(
        `UPDATE document_upload_notification_outbox
            SET status = 'completed', completed_at = NOW(), updated_at = NOW(), last_error = NULL
          WHERE id = $1 AND firm_id = $2 AND status = 'processing' AND attempts = $3`,
        [job.id, job.firm_id, job.attempts]
      );
      return { id: Number(job.id), completed: true, skipped: true };
    }

    const notificationResult = await createDocumentUploadNotification({
      firmId: Number(job.firm_id),
      uploaderPersonId: Number(job.uploader_person_id),
      document: { ...snapshot, id: snapshot.document_id },
      db,
      pusher,
    });
    if (!notificationResult) {
      const { rows: linkedRows } = await db.query(
        `SELECT 1
           FROM document_upload_notification_documents
          WHERE firm_id = $1 AND document_id = $2
          LIMIT 1`,
        [job.firm_id, job.document_id]
      );
      if (!linkedRows[0]) {
        // The immutable event is eligible, so a missing active route is
        // recoverable configuration state and should remain retryable.
        throw new Error('No active document notification recipients configured');
      }
    }
    await db.query(
      `UPDATE document_upload_notification_outbox
          SET status = 'completed', completed_at = NOW(), updated_at = NOW(), last_error = NULL
        WHERE id = $1 AND firm_id = $2 AND status = 'processing' AND attempts = $3`,
      [job.id, job.firm_id, job.attempts]
    );
    return { id: Number(job.id), completed: true };
  } catch (error) {
    await db.query(
      `UPDATE document_upload_notification_outbox
          SET status = 'pending',
              next_attempt_at = NOW() + (LEAST(attempts, 10) * INTERVAL '1 minute'),
              last_error = $3, updated_at = NOW()
        WHERE id = $1 AND firm_id = $2 AND status = 'processing' AND attempts = $4`,
      [job.id, job.firm_id, String(error.message || error).slice(0, 1000), job.attempts]
    ).catch(() => {});
    throw error;
  }
}

let documentNotificationWorkerStarted = false;
let documentNotificationWorkerTimer = null;

function startDocumentUploadNotificationWorker(app, { intervalMs = 5000 } = {}) {
  if (documentNotificationWorkerStarted) return;
  documentNotificationWorkerStarted = true;
  const tick = () => processNextDocumentUploadNotification({
    pusher: app?.get?.('pusher') || null,
  }).catch(error => console.error('[document-upload-notification] worker error:', error.message));
  tick();
  documentNotificationWorkerTimer = setInterval(tick, intervalMs);
  if (documentNotificationWorkerTimer.unref) documentNotificationWorkerTimer.unref();
}

module.exports = {
  GROUPING_WINDOW_MINUTES,
  normalizeCategory,
  qualifiesForNotification,
  createDocumentUploadNotification,
  processNextDocumentUploadNotification,
  startDocumentUploadNotificationWorker,
};
