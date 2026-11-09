'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { sendStaffMobilePush } = require('../services/mobilePush');
const { encrypt, decrypt } = require('../utils/encryption');
const { getSignedDownloadUrl, uploadFile, buildKey, sanitizeFilename, downloadFile } = require('../services/s3');
const { queueTeamChatMessageArchive, captureQueuedTeamChatMessage, archiveTeamChatMessageEdited, archiveTeamChatMessageRemoved } = require('../services/communicationArchive');

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 3 },
});
const TEAM_CHAT_VISIBLE_INTERVAL = "INTERVAL '7 days'";
const TEAM_CHAT_ALLOWED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif',
  'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv',
  'zip',
]);
const TEAM_CHAT_BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'sh', 'ps1', 'js', 'mjs', 'vbs', 'scr', 'jar', 'app', 'dmg',
]);

function requireStaffJwt(req, res, next) {
  if (!req.firm?.userId || req.firm?.isApiToken) {
    return res.status(400).json({ error: 'Native Team Chat requires staff user authentication.' });
  }
  next();
}

function handleError(res, label, err) {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) console.error(`[team-chat] ${label}:`, err);
  res.status(status).json({ error: err.message || 'Team Chat request failed' });
}

function intId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeMemberIds(values, currentUserId) {
  const ids = new Set([Number(currentUserId)]);
  const raw = Array.isArray(values) ? values : String(values || '').split(',');
  for (const value of raw) {
    const id = intId(value?.id || value?.staff_user_id || value);
    if (id) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

async function signedAvatarUrl(avatarUrl = '') {
  if (avatarUrl && !/^https?:\/\//i.test(avatarUrl)) {
    try { avatarUrl = await getSignedDownloadUrl({ key: avatarUrl, bucket: process.env.AWS_S3_BUCKET || 'darklion-s3', expiresIn: 86400 }); } catch (_) {}
  }
  return avatarUrl;
}

async function safeUser(row) {
  const avatarUrl = await signedAvatarUrl(row.avatar_url || '');
  return {
    id: row.id,
    name: row.display_name || row.name || row.email,
    display_name: row.display_name || row.name || '',
    email: row.email,
    role: row.role,
    avatar_url: avatarUrl,
    last_login_at: row.last_login_at,
  };
}

function titleForConversation(row) {
  if (row.title) return row.title;
  const members = Array.isArray(row.members) ? row.members : [];
  if (row.conversation_type === 'dm' && members.length) {
    const other = members.find(m => Number(m.id) !== Number(row.current_staff_user_id)) || members[0];
    if (other?.name) return other.name;
  }
  if (row.member_names) return row.member_names;
  return row.conversation_type === 'dm' ? 'Direct message' : 'Team conversation';
}

async function safeConversation(row) {
  const members = await Promise.all((row.members || []).map(async (member) => ({
    ...member,
    avatar_url: await signedAvatarUrl(member.avatar_url || ''),
  })));

  return {
    id: row.id,
    conversation_id: row.id,
    current_staff_user_id: row.current_staff_user_id,
    conversation_type: row.conversation_type,
    title: titleForConversation(row),
    chat_type: row.conversation_type,
    is_pinned: !!row.is_pinned,
    is_archived: !!row.is_archived,
    is_hidden: !!row.is_hidden,
    last_message_at: row.last_message_at || row.updated_at,
    updated_at: row.updated_at,
    created_at: row.created_at,
    unread_count: Number(row.unread_count || 0),
    preview_text: row.preview_encrypted ? (decrypt(row.preview_encrypted) || '') : '',
    members,
  };
}

function safeMessage(row) {
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const decryptedBody = decrypt(row.body_encrypted) || '';
  const attachmentFallback = attachments.length && !decryptedBody
    ? attachments.map(att => `📎 ${att.file_name || 'Attachment'}`).join(', ')
    : '';
  const displayBody = decryptedBody || attachmentFallback;
  return {
    id: row.id,
    message_id: row.id,
    conversation_id: row.conversation_id,
    client_nonce: row.client_nonce || '',
    sender_staff_user_id: row.sender_staff_user_id,
    sender_name: row.sender_name || '',
    message_kind: row.message_kind,
    text: displayBody,
    body: displayBody,
    attachments,
    created_at: row.created_at,
    date: row.created_at,
    retained_at: row.retained_at,
    visible_until: row.visible_until,
    edit_deadline: row.visible_until,
    edited_at: row.edited_at,
    edit_count: Number(row.edit_count || 0),
    removed_at: row.removed_at || row.deleted_at || null,
    immutable_sha256: row.immutable_sha256,
    direction: Number(row.sender_staff_user_id) === Number(row.current_staff_user_id) ? 'outbound' : 'inbound',
    out: Number(row.sender_staff_user_id) === Number(row.current_staff_user_id),
    can_edit: !!row.can_edit,
    can_delete: !!row.can_delete,
    is_unread: (row.last_read_message_id == null || Number(row.id) > Number(row.last_read_message_id)) && Number(row.sender_staff_user_id) !== Number(row.current_staff_user_id),
  };
}

function fileExtension(name = '') {
  const clean = String(name || '').toLowerCase().split(/[?#]/)[0];
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match ? match[1] : '';
}

function validateTeamChatUpload(file = {}) {
  const ext = fileExtension(file.originalname || '');
  if (!ext || TEAM_CHAT_BLOCKED_EXTENSIONS.has(ext) || !TEAM_CHAT_ALLOWED_EXTENSIONS.has(ext)) {
    const err = new Error('Team Chat supports images, PDFs, Office files, text/CSV, and ZIP attachments.');
    err.statusCode = 400;
    throw err;
  }
}

function flattenUploadedTeamChatFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  return Object.values(files).flat().filter(Boolean);
}

async function assertMembersInFirm(firmId, memberIds) {
  const { rows } = await pool.query(
    `SELECT id FROM firm_users
     WHERE firm_id = $1
       AND id = ANY($2::int[])
       AND accepted_at IS NOT NULL
       AND archived_at IS NULL`,
    [firmId, memberIds]
  );
  if (rows.length !== memberIds.length) {
    const err = new Error('Every Team Chat member must be an accepted staff/team user in this firm.');
    err.statusCode = 400;
    throw err;
  }
}

async function requireConversationMember({ firmId, staffUserId, conversationId }) {
  const { rows } = await pool.query(
    `SELECT c.*
     FROM native_team_chat_conversations c
     JOIN native_team_chat_members m ON m.conversation_id = c.id AND m.firm_id = c.firm_id
     JOIN LATERAL (
       SELECT COUNT(*)::int AS active_member_count
       FROM native_team_chat_members active_m
       JOIN firm_users active_u ON active_u.id = active_m.staff_user_id AND active_u.firm_id = active_m.firm_id
        AND active_u.accepted_at IS NOT NULL
        AND active_u.archived_at IS NULL
       WHERE active_m.firm_id = c.firm_id
         AND active_m.conversation_id = c.id
         AND active_m.left_at IS NULL
     ) active_members ON TRUE
     WHERE c.firm_id = $1 AND c.id = $2 AND m.staff_user_id = $3 AND m.left_at IS NULL
       AND active_members.active_member_count >= 2
     LIMIT 1`,
    [firmId, conversationId, staffUserId]
  );
  if (!rows[0]) {
    const err = new Error('Team Chat conversation not found.');
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

async function findDm(firmId, memberIds) {
  if (memberIds.length !== 2) return null;
  const { rows } = await pool.query(
    `SELECT c.id
     FROM native_team_chat_conversations c
     JOIN native_team_chat_members m ON m.conversation_id = c.id AND m.firm_id = c.firm_id AND m.left_at IS NULL
     WHERE c.firm_id = $1 AND c.conversation_type = 'dm'
     GROUP BY c.id
     HAVING ARRAY_AGG(m.staff_user_id ORDER BY m.staff_user_id) = $2::int[]
     LIMIT 1`,
    [firmId, memberIds]
  );
  return rows[0]?.id || null;
}

async function findGroup(firmId, memberIds) {
  const { rows } = await pool.query(
    `SELECT c.id
     FROM native_team_chat_conversations c
     JOIN native_team_chat_members m ON m.conversation_id = c.id AND m.firm_id = c.firm_id AND m.left_at IS NULL
     WHERE c.firm_id = $1 AND c.conversation_type = 'group'
     GROUP BY c.id
     HAVING ARRAY_AGG(m.staff_user_id ORDER BY m.staff_user_id) = $2::int[]
     LIMIT 1`,
    [firmId, memberIds]
  );
  return rows[0]?.id || null;
}

async function createConversation({ firmId, staffUserId, type, title, memberIds }) {
  const conversationType = type === 'group' ? 'group' : 'dm';
  const members = normalizeMemberIds(memberIds, staffUserId);
  if (conversationType === 'dm' && members.length !== 2) {
    const err = new Error('Direct messages require exactly one other staff/team user.');
    err.statusCode = 400;
    throw err;
  }
  if (conversationType === 'group' && members.length < 3) {
    const err = new Error('Groups require at least three people. For one teammate, use a direct message.');
    err.statusCode = 400;
    throw err;
  }
  await assertMembersInFirm(firmId, members);

  const existingConversationId = conversationType === 'dm' ? await findDm(firmId, members) : await findGroup(firmId, members);
  if (existingConversationId) {
    if (conversationType === 'group' && String(title || '').trim()) {
      await pool.query(
        `UPDATE native_team_chat_conversations SET title = $3, updated_at = NOW() WHERE firm_id = $1 AND id = $2`,
        [firmId, existingConversationId, String(title || '').trim()]
      );
    }
    await setUserState({ firmId, staffUserId, conversationId: existingConversationId, field: 'is_hidden', value: false });
    await setUserState({ firmId, staffUserId, conversationId: existingConversationId, field: 'is_archived', value: false });
    return getConversation({ firmId, staffUserId, conversationId: existingConversationId });
  }

  const { rows } = await pool.query(
    `INSERT INTO native_team_chat_conversations (firm_id, conversation_type, title, created_by_staff_user_id, updated_at)
     VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
    [firmId, conversationType, conversationType === 'group' ? String(title || '').trim() : '', staffUserId]
  );
  const conversation = rows[0];
  for (const memberId of members) {
    await pool.query(
      `INSERT INTO native_team_chat_members (firm_id, conversation_id, staff_user_id, member_role, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (firm_id, conversation_id, staff_user_id) DO UPDATE SET left_at = NULL, updated_at = NOW()`,
      [firmId, conversation.id, memberId, memberId === Number(staffUserId) ? 'owner' : 'member']
    );
    await pool.query(
      `INSERT INTO native_team_chat_user_state (firm_id, conversation_id, staff_user_id, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (firm_id, conversation_id, staff_user_id) DO NOTHING`,
      [firmId, conversation.id, memberId]
    );
  }
  return getConversation({ firmId, staffUserId, conversationId: conversation.id });
}

async function getConversation({ firmId, staffUserId, conversationId }) {
  const { rows } = await pool.query(
    `WITH member_json AS (
       SELECT m.conversation_id,
              JSON_AGG(JSON_BUILD_OBJECT('id', u.id, 'name', COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email), 'email', u.email, 'role', u.role, 'avatar_url', u.avatar_url) ORDER BY COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email)) AS members,
              STRING_AGG(COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email), ', ' ORDER BY COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email)) AS member_names
       FROM native_team_chat_members m
       JOIN firm_users u ON u.id = m.staff_user_id AND u.firm_id = m.firm_id
        AND u.accepted_at IS NOT NULL
        AND u.archived_at IS NULL
       WHERE m.firm_id = $1 AND m.left_at IS NULL
       GROUP BY m.conversation_id
     ), active_member_counts AS (
       SELECT m.conversation_id, COUNT(*)::int AS active_member_count
       FROM native_team_chat_members m
       JOIN firm_users u ON u.id = m.staff_user_id AND u.firm_id = m.firm_id
        AND u.accepted_at IS NOT NULL
        AND u.archived_at IS NULL
       WHERE m.firm_id = $1 AND m.left_at IS NULL
       GROUP BY m.conversation_id
     ), last_msg AS (
       SELECT DISTINCT ON (conversation_id) conversation_id, body_encrypted AS preview_encrypted, created_at AS last_message_at
       FROM native_team_chat_messages
       WHERE firm_id = $1
         AND deleted_at IS NULL
         AND removed_at IS NULL
         AND COALESCE(visible_until, created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW()
       ORDER BY conversation_id, created_at DESC, id DESC
     )
     SELECT c.*, $2::int AS current_staff_user_id, COALESCE(us.is_pinned,FALSE) AS is_pinned, COALESCE(us.is_archived,FALSE) AS is_archived,
            COALESCE(us.is_hidden,FALSE) AS is_hidden, mj.members, mj.member_names, lm.preview_encrypted, lm.last_message_at,
            0 AS unread_count
     FROM native_team_chat_conversations c
     JOIN native_team_chat_members mine ON mine.conversation_id = c.id AND mine.firm_id = c.firm_id AND mine.staff_user_id = $2 AND mine.left_at IS NULL
     LEFT JOIN native_team_chat_user_state us ON us.conversation_id = c.id AND us.firm_id = c.firm_id AND us.staff_user_id = $2
     LEFT JOIN member_json mj ON mj.conversation_id = c.id
     LEFT JOIN active_member_counts amc ON amc.conversation_id = c.id
     LEFT JOIN last_msg lm ON lm.conversation_id = c.id
     WHERE c.firm_id = $1 AND c.id = $3
       AND COALESCE(amc.active_member_count,0) >= 2
     LIMIT 1`,
    [firmId, staffUserId, conversationId]
  );
  if (!rows[0]) {
    const err = new Error('Team Chat conversation not found.');
    err.statusCode = 404;
    throw err;
  }
  return safeConversation(rows[0]);
}

async function listConversations({ firmId, staffUserId, includeArchived = false, includeHidden = false, limit = 100 }) {
  const { rows } = await pool.query(
    `WITH member_json AS (
       SELECT m.conversation_id,
              JSON_AGG(JSON_BUILD_OBJECT('id', u.id, 'name', COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email), 'email', u.email, 'role', u.role, 'avatar_url', u.avatar_url) ORDER BY COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email)) AS members,
              STRING_AGG(COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email), ', ' ORDER BY COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email)) AS member_names
       FROM native_team_chat_members m
       JOIN firm_users u ON u.id = m.staff_user_id AND u.firm_id = m.firm_id
        AND u.accepted_at IS NOT NULL
        AND u.archived_at IS NULL
       WHERE m.firm_id = $1 AND m.left_at IS NULL
       GROUP BY m.conversation_id
     ), active_member_counts AS (
       SELECT m.conversation_id, COUNT(*)::int AS active_member_count
       FROM native_team_chat_members m
       JOIN firm_users u ON u.id = m.staff_user_id AND u.firm_id = m.firm_id
        AND u.accepted_at IS NOT NULL
        AND u.archived_at IS NULL
       WHERE m.firm_id = $1 AND m.left_at IS NULL
       GROUP BY m.conversation_id
     ), last_msg AS (
       SELECT DISTINCT ON (conversation_id) conversation_id, body_encrypted AS preview_encrypted, created_at AS last_message_at, id AS last_message_id
       FROM native_team_chat_messages
       WHERE firm_id = $1
         AND deleted_at IS NULL
         AND removed_at IS NULL
         AND COALESCE(visible_until, created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW()
       ORDER BY conversation_id, created_at DESC, id DESC
     )
     SELECT c.*, $2::int AS current_staff_user_id, COALESCE(us.is_pinned,FALSE) AS is_pinned, COALESCE(us.is_archived,FALSE) AS is_archived,
            COALESCE(us.is_hidden,FALSE) AS is_hidden, mj.members, mj.member_names, lm.preview_encrypted, lm.last_message_at,
            COALESCE(unread.count,0) AS unread_count
     FROM native_team_chat_conversations c
     JOIN native_team_chat_members mine ON mine.conversation_id = c.id AND mine.firm_id = c.firm_id AND mine.staff_user_id = $2 AND mine.left_at IS NULL
     LEFT JOIN native_team_chat_user_state us ON us.conversation_id = c.id AND us.firm_id = c.firm_id AND us.staff_user_id = $2
     LEFT JOIN native_team_chat_read_state rs ON rs.conversation_id = c.id AND rs.firm_id = c.firm_id AND rs.staff_user_id = $2
     LEFT JOIN member_json mj ON mj.conversation_id = c.id
     LEFT JOIN active_member_counts amc ON amc.conversation_id = c.id
     LEFT JOIN last_msg lm ON lm.conversation_id = c.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS count FROM native_team_chat_messages msg
       WHERE msg.firm_id = c.firm_id AND msg.conversation_id = c.id AND msg.sender_staff_user_id IS DISTINCT FROM $2
         AND msg.deleted_at IS NULL
         AND msg.removed_at IS NULL
         AND COALESCE(msg.visible_until, msg.created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW()
         AND (rs.last_read_message_id IS NULL OR msg.id > rs.last_read_message_id)
     ) unread ON TRUE
     WHERE c.firm_id = $1
       AND ($3::boolean OR COALESCE(us.is_archived,FALSE) = FALSE)
       AND ($4::boolean OR COALESCE(us.is_hidden,FALSE) = FALSE)
       AND COALESCE(amc.active_member_count,0) >= 2
     ORDER BY COALESCE(us.is_pinned,FALSE) DESC, COALESCE(lm.last_message_at, c.updated_at) DESC
     LIMIT $5`,
    [firmId, staffUserId, !!includeArchived, !!includeHidden, Math.min(Number(limit) || 100, 200)]
  );
  return Promise.all(rows.map(safeConversation));
}

// Caller must already have verified conversation membership.
async function queryMessages({ firmId, staffUserId, conversationId, limit = 50, messageId = null }) {
  const { rows } = await pool.query(
    `SELECT msg.*, $2::int AS current_staff_user_id, rs.last_read_message_id, COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email, 'Unknown') AS sender_name,
            COALESCE(msg.visible_until, msg.created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) AS visible_until,
            (msg.sender_staff_user_id = $2 AND COALESCE(msg.visible_until, msg.created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW() AND msg.deleted_at IS NULL AND msg.removed_at IS NULL) AS can_edit,
            (msg.sender_staff_user_id = $2 AND COALESCE(msg.visible_until, msg.created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW() AND msg.deleted_at IS NULL AND msg.removed_at IS NULL) AS can_delete,
            COALESCE(att.attachments, '[]'::json) AS attachments
     FROM native_team_chat_messages msg
     LEFT JOIN firm_users u ON u.id = msg.sender_staff_user_id AND u.firm_id = msg.firm_id
     LEFT JOIN LATERAL (
       SELECT JSON_AGG(JSON_BUILD_OBJECT('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type, 'byte_size', a.byte_size, 'sha256', a.sha256, 'metadata', a.metadata) ORDER BY a.id) AS attachments
       FROM native_team_chat_attachments a
       WHERE a.firm_id = msg.firm_id AND a.message_id = msg.id
     ) att ON TRUE
     LEFT JOIN native_team_chat_read_state rs ON rs.conversation_id = msg.conversation_id AND rs.firm_id = msg.firm_id AND rs.staff_user_id = $2
     WHERE msg.firm_id = $1 AND msg.conversation_id = $3
       AND ($5::bigint IS NULL OR msg.id = $5::bigint)
       AND msg.deleted_at IS NULL
       AND msg.removed_at IS NULL
       AND COALESCE(msg.visible_until, msg.created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW()
     ORDER BY msg.created_at DESC, msg.id DESC
     LIMIT $4`,
    [firmId, staffUserId, conversationId, Math.min(Number(limit) || 50, 200), messageId]
  );
  return rows.reverse().map(safeMessage);
}

async function listMessages({ firmId, staffUserId, conversationId, limit = 50 }) {
  await requireConversationMember({ firmId, staffUserId, conversationId });
  return queryMessages({ firmId, staffUserId, conversationId, limit });
}

async function listConversationMemberIds({ firmId, conversationId }) {
  const { rows } = await pool.query(
    `SELECT m.staff_user_id
     FROM native_team_chat_members m
     JOIN firm_users u ON u.id = m.staff_user_id AND u.firm_id = m.firm_id
      AND u.accepted_at IS NOT NULL
      AND u.archived_at IS NULL
     WHERE m.firm_id = $1 AND m.conversation_id = $2 AND m.left_at IS NULL
     ORDER BY m.staff_user_id`,
    [firmId, conversationId]
  );
  return rows.map(row => Number(row.staff_user_id)).filter(Boolean);
}

// One Pusher request per 10 members instead of one per member.
async function triggerForMembers(pusher, { firmId, memberIds, name, data }) {
  if (typeof pusher.triggerBatch !== 'function') {
    await Promise.all(memberIds.map(staffUserId => pusher.trigger(`private-team-chat-${firmId}-${staffUserId}`, name, data)));
    return;
  }
  const chunks = [];
  for (let i = 0; i < memberIds.length; i += 10) {
    chunks.push(memberIds.slice(i, i + 10).map(staffUserId => ({ channel: `private-team-chat-${firmId}-${staffUserId}`, name, data })));
  }
  await Promise.all(chunks.map(chunk => pusher.triggerBatch(chunk)));
}

async function broadcastMessage(req, { firmId, conversationId, message, memberIds = null }) {
  const pusher = req.app.get('pusher');
  if (!pusher || !message?.id) return;
  try {
    const ids = memberIds || await listConversationMemberIds({ firmId, conversationId });
    await triggerForMembers(pusher, {
      firmId,
      memberIds: ids,
      name: 'team-chat-message',
      data: {
        conversation_id: conversationId,
        message_id: message.id,
        sender_staff_user_id: message.sender_staff_user_id,
        sent_at: message.created_at || message.date || new Date().toISOString(),
        message,
      },
    });
  } catch (err) {
    console.error('[team-chat] pusher broadcast failed:', err.message);
  }
}

async function pushTeamChatMessage({ firmId, conversationId, senderStaffUserId, message, memberIds = null }) {
  if (!message?.id) return;
  const ids = memberIds || await listConversationMemberIds({ firmId, conversationId });
  const recipientIds = ids.filter(id => Number(id) !== Number(senderStaffUserId));
  if (!recipientIds.length) return;

  const senderName = message.sender_name || 'Team Chat';
  const preview = message.text || message.body || 'Sent an attachment.';
  await Promise.all(recipientIds.map(staffUserId => sendStaffMobilePush({
    firmId,
    staffUserId,
    type: 'team_chat',
    title: 'New team chat',
    body: `${senderName}: ${preview}`,
    data: {
      conversationId,
      messageId: message.id,
      senderStaffUserId,
    },
  })));
}

async function broadcastDeletedMessage(req, { firmId, conversationId, messageId }) {
  const pusher = req.app.get('pusher');
  if (!pusher || !messageId) return;
  try {
    const memberIds = await listConversationMemberIds({ firmId, conversationId });
    await Promise.all(memberIds.map(staffUserId => pusher.trigger(
      `private-team-chat-${firmId}-${staffUserId}`,
      'team-chat-message-deleted',
      {
        conversation_id: conversationId,
        message_id: messageId,
        deleted_at: new Date().toISOString(),
      }
    )));
  } catch (err) {
    console.error('[team-chat] pusher delete broadcast failed:', err.message);
  }
}

async function broadcastEditedMessage(req, { firmId, conversationId, message }) {
  const pusher = req.app.get('pusher');
  if (!pusher || !message?.id) return;
  try {
    const memberIds = await listConversationMemberIds({ firmId, conversationId });
    await Promise.all(memberIds.map(staffUserId => pusher.trigger(
      `private-team-chat-${firmId}-${staffUserId}`,
      'team-chat-message-edited',
      {
        conversation_id: conversationId,
        message,
      }
    )));
  } catch (err) {
    console.error('[team-chat] pusher edit broadcast failed:', err.message);
  }
}

async function findMessageIdByNonce({ firmId, conversationId, nonce }) {
  if (!nonce) return null;
  const { rows } = await pool.query(
    `SELECT id FROM native_team_chat_messages WHERE firm_id = $1 AND conversation_id = $2 AND client_nonce = $3 LIMIT 1`,
    [firmId, conversationId, nonce]
  );
  return rows[0]?.id || null;
}

// Writes the message, its attachments, the sender's read state and the durable
// archive job in one transaction. Returns { message, created, archiveJob }.
// created is false when this client_nonce was already stored (a retry).
async function sendMessage({ firmId, staffUserId, conversationId, conversation = null, body, attachments = [], clientNonce = '' }) {
  const conv = conversation || await requireConversationMember({ firmId, staffUserId, conversationId });
  const text = String(body || '').replace(/^\n+|\n+$/g, '');
  const attachmentRows = Array.isArray(attachments) ? attachments : [];
  if (!text && attachmentRows.length === 0) {
    const err = new Error('Message text or attachment metadata is required.');
    err.statusCode = 400;
    throw err;
  }
  const nonce = String(clientNonce || crypto.randomUUID());
  const sha = crypto.createHash('sha256').update(`${firmId}:${conversationId}:${staffUserId}:${text}:${JSON.stringify(attachmentRows)}`).digest('hex');
  let messageId = null;
  let created = false;
  let archiveJob = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO native_team_chat_messages (firm_id, conversation_id, sender_staff_user_id, message_kind, body_encrypted, immutable_sha256, client_nonce, metadata, visible_until)
       VALUES ($1,$2,$3,'text',$4,$5,$6,$7,NOW() + ${TEAM_CHAT_VISIBLE_INTERVAL})
       ON CONFLICT (firm_id, conversation_id, client_nonce) DO NOTHING
       RETURNING *`,
      [firmId, conversationId, staffUserId, text ? encrypt(text) : null, sha, nonce, JSON.stringify({ source: 'native_team_chat' })]
    );
    const inserted = rows[0];
    if (inserted) {
      created = true;
      messageId = inserted.id;
      const storedAttachments = [];
      for (const att of attachmentRows) {
        const stored = await client.query(
          `INSERT INTO native_team_chat_attachments (firm_id, message_id, storage_key, file_name, content_type, byte_size, sha256, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, storage_key, file_name, content_type, byte_size, sha256, metadata`,
          [firmId, inserted.id, att.storage_key || att.storageKey || '', att.file_name || att.fileName || '', att.content_type || att.contentType || '', att.byte_size || att.byteSize || null, att.sha256 || '', JSON.stringify(att.metadata || {})]
        );
        storedAttachments.push(stored.rows[0]);
      }
      await client.query(`UPDATE native_team_chat_conversations SET updated_at = NOW() WHERE firm_id = $1 AND id = $2`, [firmId, conversationId]);
      await client.query(
        `INSERT INTO native_team_chat_read_state (firm_id, conversation_id, staff_user_id, last_read_message_id, last_read_at, updated_at)
         VALUES ($1,$2,$3,$4,NOW(),NOW())
         ON CONFLICT (firm_id, conversation_id, staff_user_id) DO UPDATE SET
           last_read_message_id = GREATEST(COALESCE(native_team_chat_read_state.last_read_message_id, 0), COALESCE(EXCLUDED.last_read_message_id, 0)),
           last_read_at = NOW(), updated_at = NOW()`,
        [firmId, conversationId, staffUserId, inserted.id]
      );
      // The archive job commits with the message: a message can never exist
      // without a durable record that it still has to be archived.
      archiveJob = await queueTeamChatMessageArchive(client, {
        firmId,
        row: { ...inserted, conversation_type: conv.conversation_type, title: conv.title },
        attachmentRows: storedAttachments,
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!messageId) messageId = await findMessageIdByNonce({ firmId, conversationId, nonce });
  const message = (await queryMessages({ firmId, staffUserId, conversationId, limit: 1, messageId }))[0];
  if (!message) {
    const err = new Error('Message not found.');
    err.statusCode = 404;
    throw err;
  }
  return { message, created, archiveJob };
}

async function loadEditableMessage({ firmId, staffUserId, messageId }) {
  const { rows } = await pool.query(
    `SELECT msg.*, COALESCE(msg.visible_until, msg.created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) AS visible_until,
            COALESCE(att.attachment_count,0)::int AS attachment_count
     FROM native_team_chat_messages msg
     JOIN native_team_chat_members m ON m.conversation_id = msg.conversation_id
      AND m.firm_id = msg.firm_id
      AND m.staff_user_id = $2
      AND m.left_at IS NULL
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS attachment_count
       FROM native_team_chat_attachments a
       WHERE a.firm_id = msg.firm_id AND a.message_id = msg.id
     ) att ON TRUE
     WHERE msg.firm_id = $1
       AND msg.id = $3
       AND msg.deleted_at IS NULL
       AND msg.removed_at IS NULL
     LIMIT 1`,
    [firmId, staffUserId, messageId]
  );
  const message = rows[0];
  if (!message) {
    const err = new Error('Message not found.');
    err.statusCode = 404;
    throw err;
  }
  if (Number(message.sender_staff_user_id) !== Number(staffUserId)) {
    const err = new Error('Only the sender can change this Team Chat message.');
    err.statusCode = 403;
    throw err;
  }
  if (new Date(message.visible_until).getTime() <= Date.now()) {
    const err = new Error('Team Chat messages can only be changed within 7 days.');
    err.statusCode = 403;
    throw err;
  }
  return message;
}

// Callers have already verified membership (loadEditableMessage joins it).
async function getMessageById({ firmId, staffUserId, conversationId, messageId }) {
  const messages = await queryMessages({ firmId, staffUserId, conversationId, limit: 1, messageId });
  return messages[0] || null;
}

async function setUserState({ firmId, staffUserId, conversationId, field, value }) {
  await requireConversationMember({ firmId, staffUserId, conversationId });
  const allowed = new Set(['is_archived', 'is_hidden', 'is_pinned']);
  if (!allowed.has(field)) throw new Error('Invalid Team Chat state field.');
  const { rows } = await pool.query(
    `INSERT INTO native_team_chat_user_state (firm_id, conversation_id, staff_user_id, ${field}, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (firm_id, conversation_id, staff_user_id) DO UPDATE SET ${field} = EXCLUDED.${field}, updated_at = NOW()
     RETURNING *`,
    [firmId, conversationId, staffUserId, !!value]
  );
  return rows[0];
}

async function markRead({ firmId, staffUserId, conversationId, messageId = null }) {
  await requireConversationMember({ firmId, staffUserId, conversationId });
  const finalMessageId = intId(messageId) || (await pool.query(
    `SELECT id FROM native_team_chat_messages
     WHERE firm_id = $1 AND conversation_id = $2
       AND deleted_at IS NULL
       AND removed_at IS NULL
       AND COALESCE(visible_until, created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW()
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [firmId, conversationId]
  )).rows[0]?.id || null;
  const { rows } = await pool.query(
    `INSERT INTO native_team_chat_read_state (firm_id, conversation_id, staff_user_id, last_read_message_id, last_read_at, updated_at)
     VALUES ($1,$2,$3,$4,NOW(),NOW())
     ON CONFLICT (firm_id, conversation_id, staff_user_id) DO UPDATE SET
       last_read_message_id = GREATEST(COALESCE(native_team_chat_read_state.last_read_message_id, 0), COALESCE(EXCLUDED.last_read_message_id, 0)),
       last_read_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [firmId, conversationId, staffUserId, finalMessageId]
  );
  return rows[0];
}

router.use(requireStaffJwt);

router.get('/status', async (req, res) => {
  res.json({ api: 'native', backend: 'darklion', telegram_core_dependency: false });
});

router.get('/unread-count', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH visible_conversations AS (
         SELECT c.id
         FROM native_team_chat_conversations c
         JOIN native_team_chat_members mine ON mine.conversation_id = c.id AND mine.firm_id = c.firm_id AND mine.staff_user_id = $2 AND mine.left_at IS NULL
         LEFT JOIN native_team_chat_user_state us ON us.conversation_id = c.id AND us.firm_id = c.firm_id AND us.staff_user_id = $2
         WHERE c.firm_id = $1
           AND COALESCE(us.is_archived,FALSE) = FALSE
           AND COALESCE(us.is_hidden,FALSE) = FALSE
       ), unread_messages AS (
	         SELECT msg.conversation_id, COUNT(*)::int AS unread_count
	         FROM native_team_chat_messages msg
	         JOIN visible_conversations vc ON vc.id = msg.conversation_id
	         LEFT JOIN native_team_chat_read_state rs ON rs.conversation_id = msg.conversation_id AND rs.firm_id = msg.firm_id AND rs.staff_user_id = $2
	         WHERE msg.firm_id = $1
	           AND msg.deleted_at IS NULL
	           AND msg.removed_at IS NULL
	           AND COALESCE(msg.visible_until, msg.created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW()
	           AND msg.sender_staff_user_id IS DISTINCT FROM $2
	           AND (rs.last_read_message_id IS NULL OR msg.id > rs.last_read_message_id)
         GROUP BY msg.conversation_id
       )
       SELECT COALESCE(SUM(unread_count),0)::int AS unread_count,
              COUNT(*)::int AS unread_conversations
       FROM unread_messages`,
      [req.firm.id, req.firm.userId]
    );
    res.json({ unread_count: Number(rows[0]?.unread_count || 0), unread_conversations: Number(rows[0]?.unread_conversations || 0) });
  } catch (err) {
    handleError(res, 'unread-count', err);
  }
});

router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, display_name, email, role, avatar_url, last_login_at
       FROM firm_users
       WHERE firm_id = $1
         AND accepted_at IS NOT NULL
         AND archived_at IS NULL
       ORDER BY COALESCE(NULLIF(display_name,''), NULLIF(name,''), email) ASC`,
      [req.firm.id]
    );
    res.json({ users: await Promise.all(rows.map(safeUser)) });
  } catch (err) {
    handleError(res, 'users', err);
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const conversations = await listConversations({ firmId: req.firm.id, staffUserId: req.firm.userId, includeArchived: req.query.include_archived === 'true', includeHidden: req.query.include_hidden === 'true', limit: req.query.limit });
    res.json({ conversations, chats: conversations });
  } catch (err) {
    handleError(res, 'conversations', err);
  }
});

router.get('/chats', async (req, res) => {
  try {
    const conversations = await listConversations({ firmId: req.firm.id, staffUserId: req.firm.userId, includeArchived: req.query.include_archived === 'true', includeHidden: req.query.include_hidden === 'true', limit: req.query.limit });
    res.json({ conversations, chats: conversations });
  } catch (err) {
    handleError(res, 'chats', err);
  }
});

router.post('/conversations', async (req, res) => {
  try {
    const conversation = await createConversation({ firmId: req.firm.id, staffUserId: req.firm.userId, type: req.body?.type || req.body?.conversation_type, title: req.body?.title, memberIds: req.body?.member_ids || req.body?.memberIds || req.body?.members });
    res.status(201).json({ conversation });
  } catch (err) {
    handleError(res, 'conversations/create', err);
  }
});

router.post('/conversations/dm', async (req, res) => {
  try {
    const otherId = req.body?.staff_user_id || req.body?.staffUserId || req.body?.member_id || req.body?.memberId;
    const conversation = await createConversation({ firmId: req.firm.id, staffUserId: req.firm.userId, type: 'dm', memberIds: [otherId] });
    res.status(201).json({ conversation });
  } catch (err) {
    handleError(res, 'conversations/dm', err);
  }
});

router.post('/conversations/group', async (req, res) => {
  try {
    const conversation = await createConversation({ firmId: req.firm.id, staffUserId: req.firm.userId, type: 'group', title: req.body?.title || req.body?.name, memberIds: req.body?.member_ids || req.body?.memberIds || req.body?.members });
    res.status(201).json({ conversation });
  } catch (err) {
    handleError(res, 'conversations/group', err);
  }
});

router.patch('/conversations/:id', async (req, res) => {
  try {
    const conversationId = intId(req.params.id);
    const conversation = await requireConversationMember({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId });
    if (conversation.conversation_type !== 'group') {
      const err = new Error('Only group chats can be edited.');
      err.statusCode = 400;
      throw err;
    }
    const title = String(req.body?.title || req.body?.name || '').trim();
    if (!title) {
      const err = new Error('Group name is required.');
      err.statusCode = 400;
      throw err;
    }
    await pool.query(
      `UPDATE native_team_chat_conversations SET title = $3, updated_at = NOW() WHERE firm_id = $1 AND id = $2`,
      [req.firm.id, conversationId, title]
    );
    res.json({ conversation: await getConversation({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId }) });
  } catch (err) {
    handleError(res, 'conversations/edit', err);
  }
});

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const conversationId = intId(req.params.id);
    const messages = await listMessages({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId, limit: req.query.limit });
    res.json({ messages });
  } catch (err) {
    handleError(res, 'messages/list', err);
  }
});

router.get('/messages', async (req, res) => {
  try {
    const conversationId = intId(req.query.conversation_id || req.query.conversationId || req.query.peer);
    if (!conversationId) {
      const err = new Error('conversation_id is required.');
      err.statusCode = 400;
      throw err;
    }
    const messages = await listMessages({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId, limit: req.query.limit });
    res.json({ messages });
  } catch (err) {
    handleError(res, 'messages', err);
  }
});

router.post('/messages/send', upload.fields([
  { name: 'attachment', maxCount: 3 },
  { name: 'attachments', maxCount: 3 },
]), async (req, res) => {
  try {
    const conversationId = intId(req.body?.conversation_id || req.body?.conversationId || req.body?.peer);
    if (!conversationId) {
      const err = new Error('conversation_id is required.');
      err.statusCode = 400;
      throw err;
    }
    const firmId = req.firm.id;
    const staffUserId = req.firm.userId;
    const clientNonce = String(req.body?.client_nonce || req.body?.clientNonce || '');
    const conversation = await requireConversationMember({ firmId, staffUserId, conversationId });
    let attachments = req.body?.attachments || [];
    const uploadedFiles = flattenUploadedTeamChatFiles(req.files);
    if (uploadedFiles.length > 3) {
      const err = new Error('You can attach up to 3 files to one Team Chat message.');
      err.statusCode = 400;
      throw err;
    }
    // A retry of a message that already landed must not upload its files again.
    const alreadyStored = uploadedFiles.length ? await findMessageIdByNonce({ firmId, conversationId, nonce: clientNonce }) : null;
    if (uploadedFiles.length && !alreadyStored) {
      const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
      for (const file of uploadedFiles) validateTeamChatUpload(file);
      attachments = await Promise.all(uploadedFiles.map(async (file) => {
        const filename = sanitizeFilename(file.originalname || 'team-chat-file');
        const storageKey = buildKey({
          firmId,
          ownerType: 'team-chat',
          ownerId: conversationId,
          year: new Date().getFullYear(),
          docType: 'attachments',
          filename,
        });
        await uploadFile({ firmId, buffer: file.buffer, key: storageKey, mimeType: file.mimetype, bucket });
        return {
          storage_key: storageKey,
          file_name: filename,
          content_type: file.mimetype,
          byte_size: file.size,
          sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
          metadata: { source: 'native_team_chat_upload', bucket },
        };
      }));
    }
    const { message, created, archiveJob } = await sendMessage({ firmId, staffUserId, conversationId, conversation, body: req.body?.message || req.body?.body || '', attachments, clientNonce });
    res.status(201).json({ message });
    // Everything below runs after the reply. A retried nonce is not announced twice.
    if (!created) return;
    listConversationMemberIds({ firmId, conversationId }).then((memberIds) => {
      broadcastMessage(req, { firmId, conversationId, message, memberIds }).catch(err => console.error('[team-chat] broadcast enqueue failed:', err.message));
      pushTeamChatMessage({ firmId, conversationId, senderStaffUserId: staffUserId, message, memberIds }).catch(err => console.error('[mobile-push] team-chat non-fatal:', err.message));
    }).catch(err => console.error('[team-chat] member lookup failed:', err.message));
    if (archiveJob) {
      captureQueuedTeamChatMessage({ ...archiveJob, requestedByStaffUserId: staffUserId })
        .catch(err => console.error('[team-chat] archive capture deferred to retry worker:', err.message));
    }
  } catch (err) {
    if (res.headersSent) console.error('[team-chat] messages/send after reply:', err);
    else handleError(res, 'messages/send', err);
  }
});

router.patch('/messages/:id', async (req, res) => {
  try {
    const messageId = intId(req.params.id);
    if (!messageId) {
      const err = new Error('Message not found.');
      err.statusCode = 404;
      throw err;
    }
    const message = await loadEditableMessage({ firmId: req.firm.id, staffUserId: req.firm.userId, messageId });
    const nextText = String(req.body?.body ?? req.body?.message ?? '').replace(/^\n+|\n+$/g, '');
    if (!nextText && Number(message.attachment_count || 0) === 0) {
      const err = new Error('Message text is required.');
      err.statusCode = 400;
      throw err;
    }
    await pool.query(
      `UPDATE native_team_chat_messages
       SET original_body_encrypted = COALESCE(original_body_encrypted, body_encrypted),
           body_encrypted = $4,
           edited_at = NOW(),
           edited_by_staff_user_id = $2,
           edit_count = COALESCE(edit_count,0) + 1
       WHERE firm_id = $1 AND id = $3`,
      [req.firm.id, req.firm.userId, messageId, nextText ? encrypt(nextText) : null]
    );
    await pool.query(
      `UPDATE native_team_chat_conversations SET updated_at = NOW() WHERE firm_id = $1 AND id = $2`,
      [req.firm.id, message.conversation_id]
    );
    const updatedMessage = await getMessageById({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId: message.conversation_id, messageId });
    await archiveTeamChatMessageEdited({ firmId: req.firm.id, messageId, requestedByStaffUserId: req.firm.userId });
    broadcastEditedMessage(req, { firmId: req.firm.id, conversationId: message.conversation_id, message: updatedMessage }).catch(err => console.error('[team-chat] edit broadcast enqueue failed:', err.message));
    res.json({ message: updatedMessage });
  } catch (err) {
    handleError(res, 'messages/edit', err);
  }
});

router.delete('/messages/:id', async (req, res) => {
  try {
    const messageId = intId(req.params.id);
    if (!messageId) {
      const err = new Error('Message not found.');
      err.statusCode = 404;
      throw err;
    }
    const message = await loadEditableMessage({ firmId: req.firm.id, staffUserId: req.firm.userId, messageId });
    await pool.query(
      `UPDATE native_team_chat_messages
       SET removed_at = NOW(), removed_by_staff_user_id = $2,
           deleted_at = NOW(), deleted_by_staff_user_id = $2
       WHERE firm_id = $1 AND id = $3`,
      [req.firm.id, req.firm.userId, messageId]
    );
    await pool.query(
      `UPDATE native_team_chat_conversations SET updated_at = NOW() WHERE firm_id = $1 AND id = $2`,
      [req.firm.id, message.conversation_id]
    );
    await archiveTeamChatMessageRemoved({ firmId: req.firm.id, messageId, requestedByStaffUserId: req.firm.userId });
    broadcastDeletedMessage(req, { firmId: req.firm.id, conversationId: message.conversation_id, messageId }).catch(err => console.error('[team-chat] delete broadcast enqueue failed:', err.message));
    res.json({ ok: true, message_id: messageId, conversation_id: message.conversation_id });
  } catch (err) {
    handleError(res, 'messages/delete', err);
  }
});

router.get('/attachments/:id/download', async (req, res) => {
  try {
    const attachmentId = intId(req.params.id);
    if (!attachmentId) {
      const err = new Error('Attachment not found.');
      err.statusCode = 404;
      throw err;
    }
    const { rows } = await pool.query(
      `SELECT a.*, msg.conversation_id
       FROM native_team_chat_attachments a
       JOIN native_team_chat_messages msg ON msg.id = a.message_id AND msg.firm_id = a.firm_id
       JOIN native_team_chat_members m ON m.conversation_id = msg.conversation_id
        AND m.firm_id = msg.firm_id
        AND m.staff_user_id = $2
        AND m.left_at IS NULL
       WHERE a.firm_id = $1 AND a.id = $3
       LIMIT 1`,
      [req.firm.id, req.firm.userId, attachmentId]
    );
    const attachment = rows[0];
    if (!attachment || !attachment.storage_key) {
      const err = new Error('Attachment file is not available.');
      err.statusCode = 404;
      throw err;
    }
    const bucket = attachment.metadata?.bucket || process.env.AWS_S3_BUCKET || 'darklion-s3';
    const url = await getSignedDownloadUrl({ key: attachment.storage_key, bucket, expiresIn: 300, filename: attachment.file_name });
    res.json({ url, file_name: attachment.file_name });
  } catch (err) {
    handleError(res, 'attachments/download', err);
  }
});

router.get('/attachments/:id/preview', async (req, res) => {
  try {
    const attachmentId = intId(req.params.id);
    if (!attachmentId) {
      const err = new Error('Attachment not found.');
      err.statusCode = 404;
      throw err;
    }
    const { rows } = await pool.query(
      `SELECT a.*, msg.conversation_id
       FROM native_team_chat_attachments a
       JOIN native_team_chat_messages msg ON msg.id = a.message_id AND msg.firm_id = a.firm_id
       JOIN native_team_chat_members m ON m.conversation_id = msg.conversation_id
        AND m.firm_id = msg.firm_id
        AND m.staff_user_id = $2
        AND m.left_at IS NULL
       WHERE a.firm_id = $1 AND a.id = $3
       LIMIT 1`,
      [req.firm.id, req.firm.userId, attachmentId]
    );
    const attachment = rows[0];
    if (!attachment || !attachment.storage_key) {
      const err = new Error('Attachment file is not available.');
      err.statusCode = 404;
      throw err;
    }
    const type = String(attachment.content_type || '').toLowerCase();
    const name = String(attachment.file_name || '').toLowerCase();
    const previewable = type.startsWith('image/') || type === 'application/pdf' || /\.(png|jpe?g|gif|webp|pdf)$/i.test(name);
    if (!previewable) {
      const err = new Error('Attachment cannot be previewed.');
      err.statusCode = 415;
      throw err;
    }
    const bucket = attachment.metadata?.bucket || process.env.AWS_S3_BUCKET || 'darklion-s3';
    // Attachments never change once stored, so the browser may keep its copy.
    const etag = attachment.sha256 ? `"${attachment.sha256}"` : '';
    const cacheControl = 'private, max-age=86400, immutable';
    if (etag && String(req.headers['if-none-match'] || '').split(',').map(v => v.trim().replace(/^W\//, '')).includes(etag)) {
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', cacheControl);
      return res.status(304).end();
    }
    const buffer = await downloadFile({ key: attachment.storage_key, bucket });
    res.setHeader('Content-Type', attachment.content_type || 'application/octet-stream');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (etag) res.setHeader('ETag', etag);
    res.send(buffer);
  } catch (err) {
    handleError(res, 'attachments/preview', err);
  }
});

for (const [action, field] of [['archive', 'is_archived'], ['hide', 'is_hidden'], ['pin', 'is_pinned']]) {
  router.post(`/conversations/:id/${action}`, async (req, res) => {
    try {
      await setUserState({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId: intId(req.params.id), field, value: req.body?.value !== false });
      const conversation = await getConversation({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId: intId(req.params.id) });
      res.json({ conversation });
    } catch (err) {
      handleError(res, `conversations/${action}`, err);
    }
  });
}

router.post('/conversations/:id/read', async (req, res) => {
  try {
    const read_state = await markRead({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId: intId(req.params.id), messageId: req.body?.message_id || req.body?.messageId });
    res.json({ read_state });
  } catch (err) {
    handleError(res, 'conversations/read', err);
  }
});

// Ephemeral "is typing" ping. Nothing is stored; members other than the sender get a push event.
router.post('/conversations/:id/typing', async (req, res) => {
  try {
    const conversationId = intId(req.params.id);
    if (!conversationId) return res.status(204).end();
    await requireConversationMember({ firmId: req.firm.id, staffUserId: req.firm.userId, conversationId });
    res.status(204).end();
    const pusher = req.app.get('pusher');
    if (!pusher) return;
    const memberIds = (await listConversationMemberIds({ firmId: req.firm.id, conversationId }))
      .filter(id => String(id) !== String(req.firm.userId));
    if (!memberIds.length) return;
    await triggerForMembers(pusher, {
      firmId: req.firm.id,
      memberIds,
      name: 'team-chat-typing',
      data: { conversation_id: conversationId, staff_user_id: req.firm.userId },
    });
  } catch (err) {
    if (res.headersSent) console.error('[team-chat] typing broadcast failed:', err.message);
    else handleError(res, 'conversations/typing', err);
  }
});

module.exports = router;
