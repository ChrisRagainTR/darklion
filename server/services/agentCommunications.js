'use strict';

const { pool } = require('../db');
const { summaryVisibility, filterSummary } = require('./summaryVisibility');
const { archiveClientMessageCreatedFailClosed } = require('./communicationArchive');
const { createReplyToken } = require('./emailReplyTokens');
const { sendPortalNotification } = require('./email');
const { sendClientMobilePush } = require('./mobilePush');

const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

class AgentCommunicationError extends Error {
  constructor(message, status = 400, code = 'communication_error', details = null) {
    super(message);
    this.name = 'AgentCommunicationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AgentCommunicationError(`${field} must be a positive integer`, 400, 'invalid_input');
  return id;
}

function isoMonth(value) {
  const month = String(value || new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AgentCommunicationError('month must use YYYY-MM', 400, 'invalid_month');
  return month;
}

function isoDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new AgentCommunicationError('date must use YYYY-MM-DD', 400, 'invalid_date');
  }
  return date;
}

function cleanText(value, field, max) {
  const text = String(value || '').replace(/^\n+|\n+$/g, '').trim();
  if (!text || text.length > max) throw new AgentCommunicationError(`${field} must be 1-${max} characters`, 400, 'invalid_input');
  return text;
}

function cleanNonce(value) {
  const nonce = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(nonce)) {
    throw new AgentCommunicationError('client_nonce must be 8-128 letters, numbers, dots, underscores, colons, or hyphens', 400, 'invalid_client_nonce');
  }
  return nonce;
}

function threadSummaryDto(row) {
  return {
    thread_id: Number(row.thread_id),
    client_name: String(row.client_name || ''),
    staff_name: String(row.staff_name || ''),
    staff_user_id: Number(row.staff_user_id) || null,
    subject: String(row.subject || ''),
    bullets: String(row.bullets || ''),
    message_count: Number(row.message_count) || 0,
  };
}

function teamSummaryDto(row) {
  return {
    conversation_id: Number(row.conversation_id),
    title: String(row.title || ''),
    conversation_type: String(row.conversation_type || ''),
    member_names: Array.isArray(row.member_names) ? row.member_names.map(String).slice(0, 100) : [],
    bullets: String(row.bullets || ''),
    message_count: Number(row.message_count) || 0,
  };
}

function summaryForStaff(summary, staffUserId, visibility) {
  const filtered = filterSummary(summary, staffUserId, visibility);
  const visibleStaff = filtered.by_staff.map(group => ({
    staff_user_id: Number(group.staff_user_id) || null,
    staff_name: String(group.staff_name || ''),
    threads: group.threads.map(threadSummaryDto),
  }));
  const teamChats = filtered.team_chats.map(teamSummaryDto);
  const threadCount = visibleStaff.reduce((sum, group) => sum + group.threads.length, 0) + teamChats.length;
  return {
    date: String(summary?.date || ''),
    generated_at: summary?.generated_at || null,
    by_staff: visibleStaff,
    team_chats: teamChats,
    thread_count: threadCount,
    team_chat_count: teamChats.length,
  };
}

async function listConversationSummaries({ firmId, staffUserId, month, db = pool }) {
  const scopedFirmId = positiveId(firmId, 'firm_id');
  const scopedStaffId = positiveId(staffUserId, 'staff_user_id');
  const normalizedMonth = isoMonth(month);
  const { rows } = await db.query(
    `SELECT cs.summary_date::text AS date, cs.summary_json,
            EXISTS (
              SELECT 1 FROM summary_views sv
              WHERE sv.firm_id = cs.firm_id AND sv.summary_date = cs.summary_date AND sv.firm_user_id = $2
            ) AS viewed
       FROM conversation_summaries cs
      WHERE cs.firm_id = $1 AND TO_CHAR(cs.summary_date, 'YYYY-MM') = $3
      ORDER BY cs.summary_date DESC`,
    [scopedFirmId, scopedStaffId, normalizedMonth]
  );
  const visibility = await summaryVisibility(scopedFirmId, scopedStaffId, db);
  const summaries = rows.map(row => {
    const visible = summaryForStaff(row.summary_json, scopedStaffId, visibility);
    return { date: row.date, viewed: row.viewed === true, thread_count: visible.thread_count };
  }).filter(row => row.thread_count > 0);
  return { month: normalizedMonth, summaries };
}

async function getConversationSummary({ firmId, staffUserId, date, markViewed = true, db = pool }) {
  const scopedFirmId = positiveId(firmId, 'firm_id');
  const scopedStaffId = positiveId(staffUserId, 'staff_user_id');
  const normalizedDate = isoDate(date);
  const { rows } = await db.query(
    `SELECT summary_date::text AS date, generated_at, summary_json
       FROM conversation_summaries WHERE firm_id = $1 AND summary_date = $2 LIMIT 1`,
    [scopedFirmId, normalizedDate]
  );
  if (!rows[0]) throw new AgentCommunicationError('Conversation summary not found', 404, 'summary_not_found');
  if (markViewed) {
    await db.query(
      `INSERT INTO summary_views (firm_id, summary_date, firm_user_id)
       VALUES ($1, $2, $3) ON CONFLICT (firm_id, summary_date, firm_user_id) DO NOTHING`,
      [scopedFirmId, normalizedDate, scopedStaffId]
    );
  }
  const summary = summaryForStaff(rows[0].summary_json, scopedStaffId, await summaryVisibility(scopedFirmId, scopedStaffId, db));
  return { ...summary, date: rows[0].date || normalizedDate, generated_at: rows[0].generated_at || summary.generated_at, viewed: markViewed };
}

async function assertActiveStaff(db, firmId, staffUserId) {
  const { rows } = await db.query(
    `SELECT id, COALESCE(NULLIF(display_name, ''), NULLIF(name, ''), email) AS name
       FROM firm_users
      WHERE id = $1 AND firm_id = $2 AND accepted_at IS NOT NULL AND archived_at IS NULL LIMIT 1`,
    [staffUserId, firmId]
  );
  if (!rows[0]) throw new AgentCommunicationError('Staff identity is inactive', 403, 'inactive_staff');
  return rows[0];
}

async function defaultNotify({ firmId, person, threadId, messageId, body, firmName, db = pool }) {
  if (!person.email) return { attempted: false, sent: false, reason: 'no_client_email' };
  try {
    const reply = await createReplyToken({ firmId, threadId, personId: person.id, staffUserId: null, purpose: 'message_notification' });
    await sendPortalNotification({
      to: person.email,
      name: `${person.first_name || ''} ${person.last_name || ''}`.trim(),
      firmName,
      firmId,
      message: body.length > 300 ? `${body.slice(0, 297).trimEnd()}…` : body,
      portalUrl: `${APP_URL}/portal`,
      replyTo: reply?.reply_address,
      replyAddress: reply?.reply_address,
    });
    await db.query('UPDATE people SET last_notification_sent_at = NOW() WHERE id = $1 AND firm_id = $2', [person.id, firmId]);
    setImmediate(() => sendClientMobilePush({
      firmId, personId: person.id, type: 'message', title: 'New secure message',
      body: body.length > 200 ? `${body.slice(0, 197).trimEnd()}…` : body,
      data: { threadId, messageId },
    }).catch(() => {}));
    return { attempted: true, sent: true };
  } catch (error) {
    console.error('[agent-communications] client notification failed:', error.message);
    return { attempted: true, sent: false, reason: 'notification_failed' };
  }
}

async function existingMessageByNonce(db, firmId, providerMessageId) {
  const { rows } = await db.query(
    `SELECT m.id AS message_id, m.thread_id, m.sender_id, m.body, m.created_at, mt.person_id
       FROM messages m JOIN message_threads mt ON mt.id = m.thread_id
      WHERE m.provider_message_id = $1 AND mt.firm_id = $2 AND m.removed_at IS NULL LIMIT 1`,
    [providerMessageId, firmId]
  );
  return rows[0] || null;
}

function assertIdempotentMatch(message, { staffUserId, body, threadId, personId }) {
  const matches = Number(message.sender_id) === Number(staffUserId)
    && String(message.body || '') === body
    && (!threadId || Number(message.thread_id) === Number(threadId))
    && (!personId || Number(message.person_id) === Number(personId));
  if (!matches) {
    throw new AgentCommunicationError('client_nonce was already used for a different message request', 409, 'idempotency_conflict');
  }
}

async function insertIdempotentMessage(db, { firmId, threadId, staffUserId, body, providerMessageId }) {
  const { rows } = await db.query(
    `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal, channel, provider_message_id, provider_status)
     VALUES ($1, 'staff', $2, $3, false, 'portal', $4, 'created')
     ON CONFLICT DO NOTHING RETURNING id AS message_id, thread_id, sender_id, body, created_at`,
    [threadId, staffUserId, body, providerMessageId]
  );
  if (rows[0]) return { ...rows[0], inserted: true };
  const existing = await existingMessageByNonce(db, firmId, providerMessageId);
  return existing ? { ...existing, inserted: false } : null;
}

async function finalizeClientMessage({ db, firmId, staffUserId, thread, message, body, archive, notify, deduplicated }) {
  if (!deduplicated) {
    await archive({ firmId, messageId: message.message_id, requestedByStaffUserId: staffUserId, extraMetadata: { source: 'mcp' } });
    await db.query(
      `UPDATE message_threads SET status = 'open', staff_archived_at = NULL, last_message_at = NOW()
        WHERE id = $1 AND firm_id = $2`,
      [message.thread_id, firmId]
    );
  }
  const notification = deduplicated
    ? { attempted: false, sent: false, reason: 'deduplicated' }
    : await notify({ firmId, person: thread, threadId: message.thread_id, messageId: message.message_id, body, firmName: thread.firm_name, db });
  return {
    ok: true,
    thread_id: Number(message.thread_id),
    message_id: Number(message.message_id),
    created_at: message.created_at || null,
    deduplicated,
    notification,
  };
}

async function sendClientMessage({ firmId, staffUserId, personId, subject, body, clientNonce, db = pool, archive = archiveClientMessageCreatedFailClosed, notify = defaultNotify }) {
  const scopedFirmId = positiveId(firmId, 'firm_id');
  const scopedStaffId = positiveId(staffUserId, 'staff_user_id');
  const scopedPersonId = positiveId(personId, 'person_id');
  const cleanBody = cleanText(body, 'body', 50_000);
  const cleanSubject = subject === undefined ? '' : String(subject).trim().slice(0, 255);
  const providerMessageId = `mcp:${scopedFirmId}:${cleanNonce(clientNonce)}`;
  await assertActiveStaff(db, scopedFirmId, scopedStaffId);
  const existing = await existingMessageByNonce(db, scopedFirmId, providerMessageId);
  if (existing) {
    assertIdempotentMatch(existing, { staffUserId: scopedStaffId, body: cleanBody, personId: scopedPersonId });
    return finalizeClientMessage({ db, firmId: scopedFirmId, staffUserId: scopedStaffId, thread: {}, message: existing, body: cleanBody, archive, notify, deduplicated: true });
  }
  const { rows } = await db.query(
    `SELECT p.id, p.first_name, p.last_name, p.email, f.name AS firm_name
       FROM people p JOIN firms f ON f.id = p.firm_id
      WHERE p.id = $1 AND p.firm_id = $2 LIMIT 1`,
    [scopedPersonId, scopedFirmId]
  );
  const person = rows[0];
  if (!person) throw new AgentCommunicationError('Person not found', 404, 'person_not_found');
  const current = await db.query(
    `SELECT id FROM message_threads
      WHERE firm_id = $1 AND person_id = $2 AND staff_user_id = $3
        AND category IS DISTINCT FROM 'internal'
      ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
    [scopedFirmId, scopedPersonId, scopedStaffId]
  );
  let threadId = current.rows[0]?.id;
  if (!threadId) {
    const created = await db.query(
      `INSERT INTO message_threads (firm_id, person_id, staff_user_id, assigned_to, subject, status, last_message_at)
       VALUES ($1, $2, $3, $3, $4, 'open', NOW()) RETURNING id`,
      [scopedFirmId, scopedPersonId, scopedStaffId, cleanSubject]
    );
    threadId = created.rows[0].id;
  }
  const message = await insertIdempotentMessage(db, { firmId: scopedFirmId, threadId, staffUserId: scopedStaffId, body: cleanBody, providerMessageId });
  if (!message) throw new AgentCommunicationError('Message could not be created', 500, 'message_create_failed');
  const deduplicated = message.inserted !== true;
  if (deduplicated) assertIdempotentMatch(message, { staffUserId: scopedStaffId, body: cleanBody, personId: scopedPersonId });
  return finalizeClientMessage({ db, firmId: scopedFirmId, staffUserId: scopedStaffId, thread: person, message, body: cleanBody, archive, notify, deduplicated });
}

async function replyToClientThread({ firmId, staffUserId, threadId, body, clientNonce, db = pool, archive = archiveClientMessageCreatedFailClosed, notify = defaultNotify }) {
  const scopedFirmId = positiveId(firmId, 'firm_id');
  const scopedStaffId = positiveId(staffUserId, 'staff_user_id');
  const scopedThreadId = positiveId(threadId, 'thread_id');
  const cleanBody = cleanText(body, 'body', 50_000);
  const providerMessageId = `mcp:${scopedFirmId}:${cleanNonce(clientNonce)}`;
  await assertActiveStaff(db, scopedFirmId, scopedStaffId);
  const existing = await existingMessageByNonce(db, scopedFirmId, providerMessageId);
  if (existing) {
    assertIdempotentMatch(existing, { staffUserId: scopedStaffId, body: cleanBody, threadId: scopedThreadId });
    return finalizeClientMessage({ db, firmId: scopedFirmId, staffUserId: scopedStaffId, thread: {}, message: existing, body: cleanBody, archive, notify, deduplicated: true });
  }
  const { rows } = await db.query(
    `SELECT mt.id, mt.person_id, p.id, p.first_name, p.last_name, p.email, f.name AS firm_name
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id AND p.firm_id = mt.firm_id
       JOIN firms f ON f.id = mt.firm_id
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_id = mt.firm_id
        AND tp.firm_user_id = $3 AND tp.archived_at IS NULL
      WHERE mt.id = $1 AND mt.firm_id = $2 AND mt.status <> 'archived'
        AND ((mt.staff_user_id = $3 AND mt.staff_archived_at IS NULL) OR tp.id IS NOT NULL)
      LIMIT 1`,
    [scopedThreadId, scopedFirmId, scopedStaffId]
  );
  const thread = rows[0];
  if (!thread) throw new AgentCommunicationError('Visible client thread not found', 404, 'thread_not_found');
  const message = await insertIdempotentMessage(db, { firmId: scopedFirmId, threadId: scopedThreadId, staffUserId: scopedStaffId, body: cleanBody, providerMessageId });
  if (!message) throw new AgentCommunicationError('Message could not be created', 500, 'message_create_failed');
  const deduplicated = message.inserted !== true;
  if (deduplicated) assertIdempotentMatch(message, { staffUserId: scopedStaffId, body: cleanBody, threadId: scopedThreadId });
  return finalizeClientMessage({ db, firmId: scopedFirmId, staffUserId: scopedStaffId, thread, message, body: cleanBody, archive, notify, deduplicated });
}

module.exports = {
  AgentCommunicationError,
  getConversationSummary,
  listConversationSummaries,
  replyToClientThread,
  sendClientMessage,
  summaryForStaff,
};
