'use strict';

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();
const CATEGORIES = ['tax', 'bookkeeping', 'other'];
const isCategory = category => category === 'tax' || category === 'bookkeeping' || category === 'other';

// Global firm API tokens do not identify a staff recipient and must never expose
// recipient inboxes, routing assignments, or staff names.
router.use((req, res, next) => {
  if (req.firm?.isApiToken) return res.status(403).json({ error: 'Staff authentication required' });
  next();
});

router.get('/routes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dnr.folder_category, dnr.staff_user_id,
              COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email) AS staff_name
         FROM document_notification_routes dnr
         JOIN firm_users fu ON fu.id = dnr.staff_user_id AND fu.firm_id = dnr.firm_id
        WHERE dnr.firm_id = $1
          AND fu.accepted_at IS NOT NULL
          AND fu.archived_at IS NULL
        ORDER BY dnr.folder_category, staff_name`,
      [req.firm.id]
    );
    const routes = Object.fromEntries(CATEGORIES.map(category => [category, []]));
    for (const row of rows) routes[row.folder_category].push({ id: row.staff_user_id, name: row.staff_name });
    res.json({ routes });
  } catch (error) {
    console.error('[document-notifications] GET routes:', error);
    res.status(500).json({ error: 'Failed to load document notification routes' });
  }
});

router.put('/routes', async (req, res) => {
  if (!['owner', 'admin'].includes(req.firm.role)) {
    return res.status(403).json({ error: 'Owner or admin access required' });
  }
  const requested = req.body?.routes;
  if (!requested || CATEGORIES.some(category => !Array.isArray(requested[category]))) {
    return res.status(400).json({ error: 'routes.tax, routes.bookkeeping, and routes.other arrays are required' });
  }
  const normalized = {};
  for (const category of CATEGORIES) {
    if (!isCategory(category)) return res.status(400).json({ error: 'Invalid category' });
    normalized[category] = [...new Set(requested[category].map(Number).filter(Number.isInteger))];
  }
  const allIds = [...new Set(Object.values(normalized).flat())];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('document_notification_routes'), $1::integer)",
      [req.firm.id]
    );
    if (allIds.length) {
      const { rows } = await client.query(
        `SELECT fu.id FROM firm_users fu
          WHERE fu.firm_id = $1 AND fu.id = ANY($2::int[])
            AND fu.accepted_at IS NOT NULL AND fu.archived_at IS NULL`,
        [req.firm.id, allIds]
      );
      if (rows.length !== allIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Every recipient must be an active staff member in this firm' });
      }
    }
    await client.query('DELETE FROM document_notification_routes WHERE firm_id = $1', [req.firm.id]);
    for (const category of CATEGORIES) {
      for (const staffUserId of normalized[category]) {
        await client.query(
          `INSERT INTO document_notification_routes (firm_id, folder_category, staff_user_id)
           VALUES ($1,$2,$3)`,
          [req.firm.id, category, staffUserId]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, routes: normalized });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[document-notifications] PUT routes:', error);
    res.status(500).json({ error: 'Failed to save document notification routes' });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;
  const archived = req.query.archived === 'true';
  const unread = req.query.unread === 'true';
  const search = String(req.query.search || '').trim().slice(0, 100);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM document_upload_notification_recipients dnr
         JOIN document_upload_notifications dun ON dun.id = dnr.notification_id AND dun.firm_id = dnr.firm_id
         JOIN people p ON p.id = dun.uploader_person_id AND p.firm_id = dun.firm_id
         LEFT JOIN people op ON dun.owner_type = 'person' AND op.id = dun.owner_id AND op.firm_id = dun.firm_id
         LEFT JOIN companies c ON dun.owner_type = 'company' AND c.id = dun.owner_id AND c.firm_id = dun.firm_id
         LEFT JOIN relationships r ON r.id = COALESCE(op.relationship_id, c.relationship_id) AND r.firm_id = dun.firm_id
        WHERE dnr.firm_id = $1 AND dnr.staff_user_id = $2
          AND (($3::boolean AND dnr.archived_at IS NOT NULL) OR (NOT $3::boolean AND dnr.archived_at IS NULL))
          AND (NOT $4::boolean OR dnr.read_at IS NULL)
          AND ($5 = '' OR dun.summary ILIKE '%' || $5 || '%' OR dun.folder_category ILIKE '%' || $5 || '%'
               OR dun.folder_subcategory ILIKE '%' || $5 || '%' OR p.first_name ILIKE '%' || $5 || '%'
               OR p.last_name ILIKE '%' || $5 || '%' OR op.first_name ILIKE '%' || $5 || '%'
               OR op.last_name ILIKE '%' || $5 || '%' OR c.company_name ILIKE '%' || $5 || '%'
               OR r.name ILIKE '%' || $5 || '%'
               OR EXISTS (SELECT 1
                    FROM document_upload_notification_documents dnrd_search
                    JOIN documents d_search ON d_search.id = dnrd_search.document_id
                      AND d_search.firm_id = dnrd_search.firm_id AND d_search.deleted_at IS NULL
                   WHERE dnrd_search.notification_id = dun.id AND dnrd_search.firm_id = dun.firm_id
                     AND d_search.display_name ILIKE '%' || $5 || '%'))`,
      [firmId, staffUserId, archived, unread, search]
    );
    const { rows } = await pool.query(
      `SELECT dun.id, dun.owner_type, dun.owner_id, dun.folder_category,
              dun.folder_subcategory, dun.year, dun.file_count, dun.summary,
              dun.created_at, dun.updated_at, dnr.read_at, dnr.archived_at,
              COALESCE(NULLIF(TRIM(p.first_name || ' ' || p.last_name), ''), 'Client') AS uploader_name,
              CASE WHEN dun.owner_type = 'company' THEN COALESCE(c.company_name, 'Company')
                   ELSE COALESCE(NULLIF(TRIM(op.first_name || ' ' || op.last_name), ''), 'Person') END AS owner_name,
              COALESCE(r.name, '') AS relationship_name,
              COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id', d.id, 'displayName', d.display_name)
                ORDER BY dnrd.id) FILTER (WHERE d.id IS NOT NULL), '[]') AS documents
         FROM document_upload_notification_recipients dnr
         JOIN document_upload_notifications dun ON dun.id = dnr.notification_id AND dun.firm_id = dnr.firm_id
         JOIN people p ON p.id = dun.uploader_person_id AND p.firm_id = dun.firm_id
         LEFT JOIN people op ON dun.owner_type = 'person' AND op.id = dun.owner_id AND op.firm_id = dun.firm_id
         LEFT JOIN companies c ON dun.owner_type = 'company' AND c.id = dun.owner_id AND c.firm_id = dun.firm_id
         LEFT JOIN relationships r ON r.id = COALESCE(op.relationship_id, c.relationship_id) AND r.firm_id = dun.firm_id
         LEFT JOIN document_upload_notification_documents dnrd ON dnrd.notification_id = dun.id AND dnrd.firm_id = dun.firm_id
         LEFT JOIN documents d ON d.id = dnrd.document_id AND d.firm_id = dun.firm_id AND d.deleted_at IS NULL
        WHERE dnr.firm_id = $1 AND dnr.staff_user_id = $2
          AND (($3::boolean AND dnr.archived_at IS NOT NULL) OR (NOT $3::boolean AND dnr.archived_at IS NULL))
          AND (NOT $4::boolean OR dnr.read_at IS NULL)
          AND ($5 = '' OR dun.summary ILIKE '%' || $5 || '%' OR dun.folder_category ILIKE '%' || $5 || '%'
               OR dun.folder_subcategory ILIKE '%' || $5 || '%' OR p.first_name ILIKE '%' || $5 || '%'
               OR p.last_name ILIKE '%' || $5 || '%' OR op.first_name ILIKE '%' || $5 || '%'
               OR op.last_name ILIKE '%' || $5 || '%' OR c.company_name ILIKE '%' || $5 || '%'
               OR r.name ILIKE '%' || $5 || '%'
               OR EXISTS (SELECT 1
                    FROM document_upload_notification_documents dnrd_search
                    JOIN documents d_search ON d_search.id = dnrd_search.document_id
                      AND d_search.firm_id = dnrd_search.firm_id AND d_search.deleted_at IS NULL
                   WHERE dnrd_search.notification_id = dun.id AND dnrd_search.firm_id = dun.firm_id
                     AND d_search.display_name ILIKE '%' || $5 || '%'))
        GROUP BY dun.id, dnr.read_at, dnr.archived_at, p.first_name, p.last_name,
                 op.first_name, op.last_name, c.company_name, r.name
        ORDER BY dun.updated_at DESC, dun.id DESC
        LIMIT $6 OFFSET $7`,
      [firmId, staffUserId, archived, unread, search, limit, offset]
    );
    const notifications = rows.map(row => ({
      id: Number(row.id),
      ownerType: row.owner_type,
      ownerId: Number(row.owner_id),
      ownerName: row.owner_name,
      uploaderName: row.uploader_name,
      relationshipName: row.relationship_name,
      category: row.folder_category,
      folderSubcategory: row.folder_subcategory,
      year: row.year,
      fileCount: Number(row.file_count),
      summary: row.summary,
      documents: row.documents,
      isRead: Boolean(row.read_at),
      isArchived: Boolean(row.archived_at),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      target: `/crm/${row.owner_type}/${row.owner_id}?tab=docs`,
    }));
    const total = Number(countRows[0]?.total || 0);
    res.json({ notifications, limit, offset, total, hasMore: offset + notifications.length < total });
  } catch (error) {
    console.error('[document-notifications] GET list:', error);
    res.status(500).json({ error: 'Failed to load document upload notifications' });
  }
});

async function updateRecipient(req, res, assignment, successKey) {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid notification' });
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;
  try {
    const { rowCount } = await pool.query(
      `UPDATE document_upload_notification_recipients dnr
          SET ${assignment}, updated_at = NOW()
         FROM document_upload_notifications dun
        WHERE dnr.notification_id = dun.id AND dun.firm_id = dnr.firm_id
          AND dnr.notification_id = $3
          AND dnr.firm_id = $1 AND dnr.staff_user_id = $2`,
      [firmId, staffUserId, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true, [successKey]: true });
  } catch (error) {
    console.error(`[document-notifications] ${successKey}:`, error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
}

router.put('/:id/read', (req, res) => updateRecipient(req, res, 'read_at = COALESCE(dnr.read_at, NOW())', 'read'));
router.put('/:id/archive', (req, res) => updateRecipient(req, res, 'archived_at = NOW()', 'archived'));
router.put('/:id/restore', (req, res) => updateRecipient(req, res, 'archived_at = NULL', 'restored'));

module.exports = router;
