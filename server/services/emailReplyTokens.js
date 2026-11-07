const { archiveClientMessageCreatedFailClosed } = require('./communicationArchive');
'use strict';

const crypto = require('crypto');
const path = require('path');
const { pool } = require('../db');
const { uploadFile, buildKey, sanitizeFilename } = require('./s3');

// Set EMAIL_REPLY_DOMAIN to the inbound domain you route to /api/email-replies/inbound.
const DEFAULT_REPLY_DOMAIN = 'messages.example.com';
const TOKEN_BYTES = 18;
const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ALLOWED_ATTACHMENT_EXT = new Set(['.pdf','.doc','.docx','.xls','.xlsx','.txt','.csv','.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.zip']);

function replyDomain() {
  return (process.env.EMAIL_REPLY_DOMAIN || DEFAULT_REPLY_DOMAIN).replace(/^@/, '').trim().toLowerCase();
}

function inboundAliasAddresses() {
  const configured = String(process.env.EMAIL_INBOUND_ALIASES || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
  return new Set([
    `reply@${replyDomain()}`,
    `support@${replyDomain()}`,
    `messages@${replyDomain()}`,
    ...configured,
  ]);
}

function isAllowedInboundRecipient(address = '') {
  const normalized = normalizeEmail(address);
  if (!normalized) return false;
  const domain = normalized.split('@').pop();
  return domain === replyDomain() || inboundAliasAddresses().has(normalized);
}

function inboundRecipientKind(address = '') {
  const normalized = normalizeEmail(address);
  const local = normalized.split('@')[0] || '';
  if (local.startsWith('support')) return 'support';
  if (local.startsWith('messages') || local.startsWith('reply')) return 'messages';
  return 'general';
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function parseReplyAddress(address = '') {
  const value = String(address || '').trim();
  const match = value.match(/reply\+([a-z0-9_-]+)@([^>\s,;]+)/i);
  if (!match) return null;
  return { token: match[1], domain: match[2].toLowerCase() };
}

async function createReplyToken({ firmId, threadId, personId, staffUserId = null, messageId = null, purpose = 'message_notification', ttlDays = 90 }) {
  if (!firmId || !threadId || !personId) {
    const err = new Error('firmId, threadId, and personId are required to create an email reply token.');
    err.statusCode = 400;
    throw err;
  }
  const token = generateToken();
  const domain = replyDomain();
  const { rows } = await pool.query(
    `INSERT INTO email_reply_tokens (
       token, firm_id, thread_id, person_id, staff_user_id, message_id, purpose, reply_address, expires_at, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + ($9::int * INTERVAL '1 day'),$10)
     RETURNING *`,
    [
      token,
      firmId,
      threadId,
      personId,
      staffUserId,
      messageId,
      purpose,
      `reply+${token}@${domain}`,
      Math.max(1, Math.min(Number(ttlDays) || 90, 365)),
      JSON.stringify({ format: 'reply+<token>@<EMAIL_REPLY_DOMAIN>' }),
    ]
  );
  return rows[0];
}

async function resolveReplyToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT ert.*, mt.status AS thread_status, p.email AS person_email, p.spouse_email
     FROM email_reply_tokens ert
     JOIN message_threads mt ON mt.id = ert.thread_id AND mt.firm_id = ert.firm_id
     JOIN people p ON p.id = ert.person_id AND p.firm_id = ert.firm_id
     WHERE ert.token = $1
       AND ert.revoked_at IS NULL
       AND (ert.expires_at IS NULL OR ert.expires_at > NOW())
     LIMIT 1`,
    [String(token)]
  );
  return rows[0] || null;
}

function extractPlainText({ text, html } = {}) {
  const original = text && String(text).trim()
    ? String(text).trim()
    : (!html ? '' : String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim());
  return stripQuotedEmail(original);
}

function stripQuotedEmail(value = '') {
  const original = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!original) return '';

  const quoteMarkers = [
    /^On .+wrote:\s*$/i,
    /^-{2,}\s*Original Message\s*-{2,}$/i,
    /^From:\s.+$/i,
    /^Sent:\s.+$/i,
    /^To:\s.+$/i,
    /^Subject:\s.+$/i,
    /^_{5,}\s*$/,
  ];
  const signatureMarkers = [
    /^--\s*$/,
    /^Sent from my (iPhone|iPad|Android|mobile device)/i,
    /^Get Outlook for /i,
    /^Sent from Outlook/i,
    /^Information in this message is for the intended recipient/i,
  ];

  const kept = [];
  for (const line of original.split('\n')) {
    const trimmed = line.trim();
    if (quoteMarkers.some((rx) => rx.test(trimmed))) break;
    if (signatureMarkers.some((rx) => rx.test(trimmed))) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }

  const cleaned = kept.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || original;
}

function normalizeEmail(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  const angle = raw.match(/<([^>]+)>/);
  const email = (angle ? angle[1] : raw).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return email ? email[0].toLowerCase() : raw;
}

function inboundAuthenticationPasses(rawHeaders = {}) {
  if (process.env.EMAIL_INBOUND_ALLOW_UNAUTHENTICATED_FALLBACK === 'true') return true;
  if (rawHeaders.mailgun_sender_matches_from === true || rawHeaders.mailgun_sender_matches_from === 'true') return true;
  const values = [];
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    const lowerKey = String(key).toLowerCase();
    if (['authentication-results','authentication_results','x-authentication-results','spf','dkim','dmarc'].includes(lowerKey)) {
      values.push(String(value || '').toLowerCase());
    }
  }
  const joined = values.join(' ');
  return /\b(dmarc|dkim|spf)\s*=\s*pass\b/.test(joined) || /\bpass\b/.test(joined);
}

function generalReplyAddress() {
  return `reply@${replyDomain()}`;
}

async function existingInboundByProviderMessage(providerMessageId) {
  const id = String(providerMessageId || '').trim();
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT message_id, thread_id, matched_status
     FROM inbound_email_replies
     WHERE provider_message_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  return { ok: true, duplicate: true, messageId: rows[0].message_id, threadId: rows[0].thread_id, matchedStatus: rows[0].matched_status };
}

async function reserveInboundEvent({ firmId, threadId, personId, emailReplyTokenId = null, fromEmail = '', fromName = '', subject = '', providerMessageId = '', rawHeaders = {}, matchedStatus = 'matched', metadata = {} }) {
  const id = String(providerMessageId || '').trim();
  if (!id) return { reserved: false, eventId: null };
  const { rows } = await pool.query(
    `INSERT INTO inbound_email_replies (
       firm_id, thread_id, person_id, message_id, email_reply_token_id,
       from_email, from_name, subject, provider_message_id, raw_headers, matched_status, metadata
     ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (provider_message_id) WHERE provider_message_id != '' DO NOTHING
     RETURNING id`,
    [firmId, threadId, personId, emailReplyTokenId, fromEmail || '', fromName || '', subject || '', id, JSON.stringify(rawHeaders || {}), matchedStatus, JSON.stringify(metadata || {})]
  );
  if (rows[0]) return { reserved: true, eventId: rows[0].id };
  const duplicate = await existingInboundByProviderMessage(id);
  return { reserved: false, duplicate };
}

async function finalizeInboundEvent({ eventId, firmId, threadId, personId, messageId, emailReplyTokenId = null, fromEmail = '', fromName = '', subject = '', providerMessageId = '', rawHeaders = {}, matchedStatus = 'matched', metadata = {} }) {
  if (eventId) {
    await pool.query(
      `UPDATE inbound_email_replies
       SET message_id = $2, matched_status = $3, metadata = $4
       WHERE id = $1`,
      [eventId, messageId, matchedStatus, JSON.stringify(metadata || {})]
    );
    return;
  }
  await pool.query(
    `INSERT INTO inbound_email_replies (
       firm_id, thread_id, person_id, message_id, email_reply_token_id,
       from_email, from_name, subject, provider_message_id, raw_headers, matched_status, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [firmId, threadId, personId, messageId, emailReplyTokenId, fromEmail || '', fromName || '', subject || '', providerMessageId || '', JSON.stringify(rawHeaders || {}), matchedStatus, JSON.stringify(metadata || {})]
  );
}

function isAllowedInboundAttachment(filename = '') {
  const ext = path.extname(filename || '').toLowerCase();
  return !!ext && ALLOWED_ATTACHMENT_EXT.has(ext);
}

function decodeAttachmentContent(attachment = {}) {
  const content = attachment.content || attachment.data || attachment.body || attachment.base64 || '';
  if (Buffer.isBuffer(content)) return content;
  if (typeof content !== 'string' || !content) return null;
  const cleaned = content.includes(',') && content.startsWith('data:') ? content.split(',').pop() : content;
  return Buffer.from(cleaned, attachment.encoding === 'utf8' ? 'utf8' : 'base64');
}

function normalizeInboundAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  let totalBytes = 0;
  const normalized = [];
  for (const attachment of attachments) {
    const filename = sanitizeFilename(attachment.filename || attachment.name || 'email-attachment');
    if (!isAllowedInboundAttachment(filename)) continue;
    const buffer = decodeAttachmentContent(attachment);
    if (!buffer || !buffer.length) continue;
    totalBytes += buffer.length;
    if (totalBytes > MAX_INBOUND_ATTACHMENT_BYTES) {
      const err = new Error('Inbound email attachments exceed the 25 MB limit.');
      err.statusCode = 413;
      throw err;
    }
    normalized.push({
      filename,
      buffer,
      mimeType: attachment.content_type || attachment.contentType || attachment.mime_type || attachment.mimeType || 'application/octet-stream',
      size: buffer.length,
    });
  }
  return normalized;
}

async function attachInboundFiles({ firmId, personId, messageId, attachments = [] }) {
  const files = normalizeInboundAttachments(attachments);
  if (!files.length) return [];
  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
  const year = String(new Date().getFullYear());
  const saved = [];
  for (const file of files) {
    const key = buildKey({ firmId, ownerType: 'person', ownerId: personId, year, docType: 'email_replies', filename: file.filename });
    await uploadFile({ firmId: firmId, buffer: file.buffer, key, mimeType: file.mimeType, bucket });
    const { rows } = await pool.query(
      `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type, size_bytes,
        s3_key, s3_bucket, year, folder_section, folder_category, uploaded_by_type, uploaded_by_id,
        is_delivered, created_at)
       VALUES ($1, 'person', $2, 'other', $3, $4, $5, $6, $7, $8, 'client_uploaded', 'message_docs', 'client', $2, true, NOW())
       RETURNING id`,
      [firmId, personId, file.filename, file.mimeType, file.size, key, bucket, year]
    );
    await pool.query('INSERT INTO message_attachments (message_id, document_id) VALUES ($1, $2)', [messageId, rows[0].id]);
    saved.push({ documentId: rows[0].id, filename: file.filename });
  }
  return saved;
}

async function resolvePersonByInboundEmail(fromEmail) {
  const normalized = normalizeEmail(fromEmail);
  if (!normalized) return null;
  const { rows } = await pool.query(
    `SELECT p.id AS person_id, p.firm_id, p.relationship_id, p.email, p.spouse_email
     FROM people p
     WHERE LOWER(p.email) = $1 OR LOWER(COALESCE(p.spouse_email, '')) = $1
     ORDER BY p.portal_last_login_at DESC NULLS LAST, p.updated_at DESC NULLS LAST, p.id DESC
     LIMIT 2`,
    [normalized]
  );
  if (rows.length !== 1) return { ambiguous: rows.length > 1, normalizedEmail: normalized };
  return { ...rows[0], normalizedEmail: normalized };
}

async function pickStaffUserForPerson({ firmId, personId }) {
  const { rows: recent } = await pool.query(
    `SELECT staff_user_id
     FROM message_threads
     WHERE firm_id = $1 AND person_id = $2 AND staff_user_id IS NOT NULL
     ORDER BY last_message_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [firmId, personId]
  );
  if (recent[0]?.staff_user_id) return recent[0].staff_user_id;

  const { rows: staff } = await pool.query(
    `SELECT id
     FROM firm_users
     WHERE firm_id = $1 AND archived_at IS NULL
     ORDER BY CASE WHEN role IN ('owner','admin') THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [firmId]
  );
  return staff[0]?.id || null;
}

async function findOrCreateFallbackThread({ firmId, personId, subject }) {
  const cleanSubject = String(subject || '').replace(/^\s*(re|fw|fwd):\s*/i, '').trim() || 'Email reply';
  const { rows: existing } = await pool.query(
    `SELECT id
     FROM message_threads
     WHERE firm_id = $1 AND person_id = $2 AND status != 'archived'
       AND category IS DISTINCT FROM 'internal'
       AND (LOWER(subject) = LOWER($3) OR $3 = 'Email reply')
     ORDER BY last_message_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [firmId, personId, cleanSubject]
  );
  if (existing[0]) return existing[0].id;

  const staffUserId = await pickStaffUserForPerson({ firmId, personId });
  const { rows } = await pool.query(
    `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, category, last_message_at)
     VALUES ($1, $2, $3, $4, 'open', 'general', NOW())
     RETURNING id`,
    [firmId, personId, staffUserId, cleanSubject]
  );
  return rows[0].id;
}

async function recordInboundReply({ token, fromEmail, fromName = '', subject = '', text = '', html = '', rawHeaders = {}, providerMessageId = '', attachments = [] }) {
  const duplicate = await existingInboundByProviderMessage(providerMessageId);
  if (duplicate) return duplicate;

  const resolved = await resolveReplyToken(token);
  if (!resolved) {
    const err = new Error('Email reply token was not found, expired, or revoked.');
    err.statusCode = 404;
    throw err;
  }

  const body = extractPlainText({ text, html });
  if (!body) {
    const err = new Error('Inbound email reply body is empty.');
    err.statusCode = 400;
    throw err;
  }

  const normalizedFrom = normalizeEmail(fromEmail);
  const expectedEmails = [resolved.person_email, resolved.spouse_email].map(normalizeEmail).filter(Boolean);
  const senderMatches = !!normalizedFrom && expectedEmails.includes(normalizedFrom);
  if (!senderMatches) {
    await reserveInboundEvent({
      firmId: resolved.firm_id,
      threadId: resolved.thread_id,
      personId: resolved.person_id,
      emailReplyTokenId: resolved.id,
      fromEmail,
      fromName,
      subject,
      providerMessageId,
      rawHeaders,
      matchedStatus: 'sender_mismatch',
      metadata: { expected_from: expectedEmails, normalized_from: normalizedFrom, token_purpose: resolved.purpose },
    });
    const err = new Error('Inbound email sender does not match the client on the reply token.');
    err.statusCode = 403;
    throw err;
  }

  const reservation = await reserveInboundEvent({
    firmId: resolved.firm_id,
    threadId: resolved.thread_id,
    personId: resolved.person_id,
    emailReplyTokenId: resolved.id,
    fromEmail,
    fromName,
    subject,
    providerMessageId,
    rawHeaders,
    matchedStatus: 'matched',
    metadata: { expected_from: expectedEmails, token_purpose: resolved.purpose },
  });
  if (reservation.duplicate) return reservation.duplicate;
  let message = null;
  try {
    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'client', $2, $3, false)
       RETURNING id, created_at`,
      [resolved.thread_id, resolved.person_id, body]
    );
    message = msgRows[0];

    const savedAttachments = await attachInboundFiles({ firmId: resolved.firm_id, personId: resolved.person_id, messageId: message.id, attachments });

    await finalizeInboundEvent({
      eventId: reservation.eventId,
      firmId: resolved.firm_id,
      threadId: resolved.thread_id,
      personId: resolved.person_id,
      messageId: message.id,
      emailReplyTokenId: resolved.id,
      fromEmail,
      fromName,
      subject,
      providerMessageId,
      rawHeaders,
      matchedStatus: 'matched',
      metadata: { expected_from: expectedEmails, token_purpose: resolved.purpose, attachments: savedAttachments.length },
    });

    await pool.query(
      `UPDATE message_threads SET status = 'open', last_message_at = NOW() WHERE id = $1 AND firm_id = $2`,
      [resolved.thread_id, resolved.firm_id]
    );

    await pool.query(
      `UPDATE email_reply_tokens SET used_at = COALESCE(used_at, NOW()) WHERE id = $1`,
      [resolved.id]
    );

    await archiveClientMessageCreatedFailClosed({ firmId: resolved.firm_id, messageId: message.id });
    return { ok: true, messageId: message.id, threadId: resolved.thread_id, matchedStatus: 'matched', attachments: savedAttachments };
  } catch (err) {
    if (message?.id) await pool.query(`UPDATE messages SET removed_at = NOW(), removal_reason = 'inbound_email_failed' WHERE id = $1 AND thread_id = $2`, [message.id, resolved.thread_id]).catch(() => {});
    if (reservation.eventId) await pool.query('DELETE FROM inbound_email_replies WHERE id = $1 AND message_id IS NULL', [reservation.eventId]).catch(() => {});
    throw err;
  }
}

async function recordInboundReplyFallback({ fromEmail, fromName = '', subject = '', text = '', html = '', rawHeaders = {}, providerMessageId = '', attachments = [] }) {
  const duplicate = await existingInboundByProviderMessage(providerMessageId);
  if (duplicate) return duplicate;

  if (!inboundAuthenticationPasses(rawHeaders)) {
    const err = new Error('Inbound email sender authentication did not pass; fallback thread creation rejected.');
    err.statusCode = 403;
    throw err;
  }

  const person = await resolvePersonByInboundEmail(fromEmail);
  if (!person || person.ambiguous || !person.person_id) {
    const err = new Error(person?.ambiguous ? 'Inbound email sender matches multiple clients; manual review required.' : 'Inbound email sender does not match a known client.');
    err.statusCode = person?.ambiguous ? 409 : 404;
    throw err;
  }

  const body = extractPlainText({ text, html });
  if (!body) {
    const err = new Error('Inbound email reply body is empty.');
    err.statusCode = 400;
    throw err;
  }

  const threadId = await findOrCreateFallbackThread({ firmId: person.firm_id, personId: person.person_id, subject });
  const reservation = await reserveInboundEvent({
    firmId: person.firm_id,
    threadId,
    personId: person.person_id,
    fromEmail,
    fromName,
    subject,
    providerMessageId,
    rawHeaders,
    matchedStatus: 'token_missing',
    metadata: { match_method: 'sender_email_fallback', normalized_from: person.normalizedEmail },
  });
  if (reservation.duplicate) return reservation.duplicate;
  let message = null;
  try {
    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'client', $2, $3, false)
       RETURNING id, created_at`,
      [threadId, person.person_id, body]
    );
    message = msgRows[0];

    const savedAttachments = await attachInboundFiles({ firmId: person.firm_id, personId: person.person_id, messageId: message.id, attachments });

    await finalizeInboundEvent({
      eventId: reservation.eventId,
      firmId: person.firm_id,
      threadId,
      personId: person.person_id,
      messageId: message.id,
      fromEmail,
      fromName,
      subject,
      providerMessageId,
      rawHeaders,
      matchedStatus: 'token_missing',
      metadata: { match_method: 'sender_email_fallback', normalized_from: person.normalizedEmail, attachments: savedAttachments.length },
    });

    await pool.query(
      `UPDATE message_threads SET status = 'open', last_message_at = NOW() WHERE id = $1 AND firm_id = $2`,
      [threadId, person.firm_id]
    );

    await archiveClientMessageCreatedFailClosed({ firmId: person.firm_id, messageId: message.id });
    return { ok: true, messageId: message.id, threadId, matchedStatus: 'token_missing', attachments: savedAttachments };
  } catch (err) {
    if (message?.id) await pool.query(`UPDATE messages SET removed_at = NOW(), removal_reason = 'inbound_email_failed' WHERE id = $1 AND thread_id = $2`, [message.id, threadId]).catch(() => {});
    if (reservation.eventId) await pool.query('DELETE FROM inbound_email_replies WHERE id = $1 AND message_id IS NULL', [reservation.eventId]).catch(() => {});
    throw err;
  }
}

module.exports = {
  createReplyToken,
  extractPlainText,
  generalReplyAddress,
  inboundAliasAddresses,
  inboundAuthenticationPasses,
  inboundRecipientKind,
  isAllowedInboundRecipient,
  normalizeEmail,
  parseReplyAddress,
  recordInboundReply,
  recordInboundReplyFallback,
  replyDomain,
  resolveReplyToken,
};
