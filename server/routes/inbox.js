'use strict';

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

function parseLimitOffset(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
  return { limit, offset };
}

function boolParam(value) {
  if (value === undefined || value === null || value === '') return null;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function threadSummary(row) {
  const personName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return {
    thread_id: row.thread_id,
    id: row.thread_id,
    relationship_id: row.relationship_id,
    relationship_name: row.relationship_name || null,
    person_id: row.person_id,
    person_name: personName,
    client_name: personName,
    from_email: row.person_email || null,
    subject: row.subject || '',
    status: row.status,
    category: row.category || null,
    assigned_staff_user_id: row.staff_user_id || null,
    assigned_staff: row.staff_name || null,
    last_message: row.last_message || '',
    last_message_preview: row.last_message ? row.last_message.slice(0, 240) : '',
    last_message_at: row.last_message_at || row.thread_last_message_at,
    last_sender_type: row.last_sender_type || null,
    unread_count: parseInt(row.unread_count, 10) || 0,
    pending_draft_count: parseInt(row.pending_draft_count, 10) || 0,
    created_at: row.created_at,
  };
}

function getScopedStaffUserId(req) {
  if (req.firm?.userId) return req.firm.userId;
  if (req.firm?.isApiToken && req.query.staff_user_id) {
    const staffUserId = parseInt(req.query.staff_user_id, 10);
    return Number.isInteger(staffUserId) ? staffUserId : null;
  }
  return null;
}

function requireScopedInbox(req, res) {
  const staffUserId = getScopedStaffUserId(req);
  if (!staffUserId) {
    res.status(400).json({ error: 'staff_user_id is required for scoped inbox access' });
    return null;
  }
  return staffUserId;
}

function messageShape(row) {
  const personName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return {
    message_id: row.message_id,
    id: row.message_id,
    thread_id: row.thread_id,
    relationship_id: row.relationship_id,
    relationship_name: row.relationship_name || null,
    person_id: row.person_id,
    person_name: personName,
    client_name: personName,
    from_email: row.person_email || null,
    sender_type: row.sender_type,
    sender_id: row.sender_id,
    sender_name: row.sender_name || null,
    body: row.body || '',
    is_internal: !!row.is_internal,
    message_type: row.message_type || 'message',
    created_at: row.created_at,
    read_at: row.read_at,
  };
}

// GET /api/inbox — global firm inbox, API-token friendly
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const { limit, offset } = parseLimitOffset(req);
  const search = (req.query.search || '').trim();
  const fromEmail = (req.query.from_email || '').trim().toLowerCase();
  const unread = boolParam(req.query.unread);
  const status = (req.query.status || '').trim().toLowerCase();
  const scopedStaffUserId = requireScopedInbox(req, res);
  if (!scopedStaffUserId) return;

  const params = [firmId];
  const where = ['mt.firm_id = $1'];
  params.push(scopedStaffUserId);
  where.push(`COALESCE(mt.staff_user_id, mt.assigned_to) = $${params.length}`);

  if (status === 'archived') {
    where.push(`(mt.status = 'archived' OR mt.staff_archived_at IS NOT NULL)`);
  } else {
    if (status) {
      params.push(status);
      where.push(`mt.status = $${params.length}`);
    }
    if (req.query.include_archived !== 'true') {
      where.push(`mt.status != 'archived' AND mt.staff_archived_at IS NULL`);
    }
  }

  if (fromEmail) {
    params.push(fromEmail);
    where.push(`LOWER(p.email) = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    where.push(`(
      mt.subject ILIKE $${idx}
      OR p.first_name ILIKE $${idx}
      OR p.last_name ILIKE $${idx}
      OR p.email ILIKE $${idx}
      OR r.name ILIKE $${idx}
      OR EXISTS (SELECT 1 FROM messages sm WHERE sm.thread_id = mt.id AND sm.body ILIKE $${idx})
    )`);
  }

  if (unread === true) {
    where.push(`EXISTS (SELECT 1 FROM messages um WHERE um.thread_id = mt.id AND um.sender_type = 'client' AND um.read_at IS NULL)`);
  } else if (unread === false) {
    where.push(`NOT EXISTS (SELECT 1 FROM messages um WHERE um.thread_id = mt.id AND um.sender_type = 'client' AND um.read_at IS NULL)`);
  }

  params.push(limit, offset);
  const limitParam = params.length - 1;
  const offsetParam = params.length;

  try {
    const { rows } = await pool.query(
      `WITH last_messages AS (
         SELECT DISTINCT ON (m.thread_id)
           m.thread_id,
           m.id AS last_message_id,
           m.body AS last_message,
           m.sender_type AS last_sender_type,
           m.created_at AS last_message_at
         FROM messages m
         WHERE COALESCE(m.is_internal, false) = false
         ORDER BY m.thread_id, m.created_at DESC, m.id DESC
       )
       SELECT
         mt.id AS thread_id,
         mt.subject,
         mt.status,
         mt.category,
         mt.staff_user_id,
         mt.last_message_at AS thread_last_message_at,
         mt.created_at,
         p.id AS person_id,
         p.first_name,
         p.last_name,
         p.email AS person_email,
         r.id AS relationship_id,
         r.name AS relationship_name,
         COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email) AS staff_name,
         lm.last_message,
         lm.last_sender_type,
         lm.last_message_at,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count,
         (SELECT COUNT(*) FROM message_drafts md WHERE md.thread_id = mt.id AND md.status = 'pending') AS pending_draft_count,
         COUNT(*) OVER() AS total_count
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN relationships r ON r.id = p.relationship_id
       LEFT JOIN firm_users fu ON fu.id = mt.staff_user_id
       LEFT JOIN last_messages lm ON lm.thread_id = mt.id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(lm.last_message_at, mt.last_message_at, mt.created_at) DESC NULLS LAST
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params
    );

    res.json({
      threads: rows.map(threadSummary),
      pagination: {
        limit,
        offset,
        count: rows.length,
        total: rows[0] ? parseInt(rows[0].total_count, 10) || rows.length : 0,
      },
    });
  } catch (err) {
    console.error('[GET /api/inbox] error:', err);
    res.status(500).json({ error: 'Failed to fetch global inbox' });
  }
});

// GET /api/inbox/threads/:id — thread detail by ID
router.get('/threads/:id', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.id, 10);
  if (!Number.isInteger(threadId)) return res.status(400).json({ error: 'Invalid thread ID' });
  const scopedStaffUserId = requireScopedInbox(req, res);
  if (!scopedStaffUserId) return;

  try {
    const { rows: threadRows } = await pool.query(
      `WITH last_messages AS (
         SELECT DISTINCT ON (m.thread_id)
           m.thread_id,
           m.body AS last_message,
           m.sender_type AS last_sender_type,
           m.created_at AS last_message_at
         FROM messages m
         WHERE COALESCE(m.is_internal, false) = false
         ORDER BY m.thread_id, m.created_at DESC, m.id DESC
       )
       SELECT
         mt.id AS thread_id,
         mt.subject,
         mt.status,
         mt.category,
         mt.staff_user_id,
         mt.last_message_at AS thread_last_message_at,
         mt.created_at,
         p.id AS person_id,
         p.first_name,
         p.last_name,
         p.email AS person_email,
         r.id AS relationship_id,
         r.name AS relationship_name,
         COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email) AS staff_name,
         lm.last_message,
         lm.last_sender_type,
         lm.last_message_at,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count,
         (SELECT COUNT(*) FROM message_drafts md WHERE md.thread_id = mt.id AND md.status = 'pending') AS pending_draft_count
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN relationships r ON r.id = p.relationship_id
       LEFT JOIN firm_users fu ON fu.id = mt.staff_user_id
       LEFT JOIN last_messages lm ON lm.thread_id = mt.id
       WHERE mt.id = $1 AND mt.firm_id = $2 AND COALESCE(mt.staff_user_id, mt.assigned_to) = $3`,
      [threadId, firmId, scopedStaffUserId]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    const { rows: messageRows } = await pool.query(
      `SELECT
         m.id AS message_id,
         m.thread_id,
         m.sender_type,
         m.sender_id,
         CASE WHEN m.sender_type = 'staff' THEN COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email)
              WHEN m.sender_type = 'agent' THEN 'Agent'
              ELSE CONCAT_WS(' ', p.first_name, p.last_name) END AS sender_name,
         m.body,
         COALESCE(m.is_internal, false) AS is_internal,
         m.message_type,
         m.created_at,
         m.read_at,
         p.id AS person_id,
         p.first_name,
         p.last_name,
         p.email AS person_email,
         r.id AS relationship_id,
         r.name AS relationship_name
       FROM messages m
       JOIN message_threads mt ON mt.id = m.thread_id
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN relationships r ON r.id = p.relationship_id
       LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
       WHERE m.thread_id = $1 AND mt.firm_id = $2 AND COALESCE(mt.staff_user_id, mt.assigned_to) = $3 AND m.removed_at IS NULL
       ORDER BY m.created_at ASC, m.id ASC`,
      [threadId, firmId, scopedStaffUserId]
    );

    res.json({
      thread: threadSummary(threadRows[0]),
      messages: messageRows.map(messageShape),
    });
  } catch (err) {
    console.error('[GET /api/inbox/threads/:id] error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// PUT /api/inbox/threads/:id/archive — archive a scoped inbox thread
// API-token friendly: staff_user_id scopes which assigned inbox the agent may modify.
router.put('/threads/:id/archive', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.id, 10);
  if (!Number.isInteger(threadId)) return res.status(400).json({ error: 'Invalid thread ID' });
  const scopedStaffUserId = requireScopedInbox(req, res);
  if (!scopedStaffUserId) return;

  try {
    const { rows } = await pool.query(
      `UPDATE message_threads
       SET status = 'archived'
       WHERE id = $1
         AND firm_id = $2
         AND COALESCE(staff_user_id, assigned_to) = $3
       RETURNING id, subject, status`,
      [threadId, firmId, scopedStaffUserId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Thread not found' });
    res.json({ ok: true, thread_id: rows[0].id, subject: rows[0].subject || '', status: rows[0].status });
  } catch (err) {
    console.error('[PUT /api/inbox/threads/:id/archive] error:', err);
    res.status(500).json({ error: 'Failed to archive thread' });
  }
});

// GET /api/inbox/messages/:id — message detail by ID
router.get('/messages/:id', async (req, res) => {
  const firmId = req.firm.id;
  const messageId = parseInt(req.params.id, 10);
  if (!Number.isInteger(messageId)) return res.status(400).json({ error: 'Invalid message ID' });
  const scopedStaffUserId = requireScopedInbox(req, res);
  if (!scopedStaffUserId) return;

  try {
    const { rows } = await pool.query(
      `SELECT
         m.id AS message_id,
         m.thread_id,
         m.sender_type,
         m.sender_id,
         CASE WHEN m.sender_type = 'staff' THEN COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email)
              WHEN m.sender_type = 'agent' THEN 'Agent'
              ELSE CONCAT_WS(' ', p.first_name, p.last_name) END AS sender_name,
         m.body,
         COALESCE(m.is_internal, false) AS is_internal,
         m.message_type,
         m.created_at,
         m.read_at,
         p.id AS person_id,
         p.first_name,
         p.last_name,
         p.email AS person_email,
         r.id AS relationship_id,
         r.name AS relationship_name
       FROM messages m
       JOIN message_threads mt ON mt.id = m.thread_id
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN relationships r ON r.id = p.relationship_id
       LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
       WHERE m.id = $1 AND mt.firm_id = $2 AND COALESCE(mt.staff_user_id, mt.assigned_to) = $3 AND m.removed_at IS NULL`,
      [messageId, firmId, scopedStaffUserId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Message not found' });

    res.json({ message: messageShape(rows[0]) });
  } catch (err) {
    console.error('[GET /api/inbox/messages/:id] error:', err);
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

module.exports = router;
