'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { inboundRecipientKind, isAllowedInboundRecipient, normalizeEmail, parseReplyAddress, recordInboundReply, recordInboundReplyFallback, replyDomain } = require('../services/emailReplyTokens');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

function authorized(req) {
  const secret = process.env.EMAIL_INBOUND_WEBHOOK_SECRET;
  if (!secret) return false;
  const got = req.get('x-darklion-email-secret') || req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.secret;
  return got === secret;
}

function firstAddress(value) {
  if (Array.isArray(value)) return value[0] || '';
  return String(value || '');
}

function headerValue(headers = {}, names = []) {
  for (const name of names) {
    if (headers[name]) return headers[name];
    const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (found) return headers[found];
  }
  return '';
}

function parseJsonMaybe(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function headersFromMailgun(body = {}) {
  const headers = { ...(parseJsonMaybe(body.headers, {}) || {}) };
  const messageHeaders = parseJsonMaybe(body['message-headers'] || body.message_headers, []);
  if (Array.isArray(messageHeaders)) {
    for (const item of messageHeaders) {
      if (Array.isArray(item) && item.length >= 2) headers[item[0]] = item[1];
      else if (item?.name && item?.value) headers[item.name] = item.value;
    }
  }
  return headers;
}

function providerMessageId(body = {}, common = {}, recipient = '') {
  const headers = headersFromMailgun(body);
  const explicit = body.message_id || body.messageId || body.provider_message_id || body.providerMessageId || body.id || body.email_id || body.emailId || body['Message-Id'] || body['message-id'];
  const headerId = headerValue(headers, ['message-id', 'Message-ID', 'x-message-id', 'X-Message-ID']);
  const value = firstAddress(explicit || headerId).trim();
  if (value) return value;
  const stable = JSON.stringify({
    recipient,
    from: common.fromEmail,
    subject: common.subject,
    date: headerValue(headers, ['date', 'Date']) || body.date || body.timestamp || body['Date'] || '',
    text: common.text,
    html: common.html,
  });
  return `hash:${crypto.createHash('sha256').update(stable).digest('hex')}`;
}

function normalizeUploadedFiles(files = []) {
  return (files || []).map((file) => ({
    filename: file.originalname || file.filename || 'email-attachment',
    contentType: file.mimetype || 'application/octet-stream',
    content: file.buffer,
  }));
}

router.post('/inbound', upload.any(), async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized inbound email webhook' });

  const body = req.body || {};
  const headers = headersFromMailgun(body);
  const recipient = firstAddress(body.to || body.recipient || body.envelope?.to || headers.to || body.Recipient || body.recipient || body['recipient']);
  const originalRecipient = firstAddress(
    body.original_recipient || body.originalRecipient || body['X-Gm-Original-To'] || body['x-gm-original-to'] || headerValue(headers, ['x-gm-original-to', 'X-Gm-Original-To'])
  );
  const parsed = parseReplyAddress(recipient);
  const allowedRecipient = isAllowedInboundRecipient(recipient) || isAllowedInboundRecipient(originalRecipient);
  if (!parsed && !allowedRecipient) {
    return res.status(400).json({ error: 'Inbound email recipient is not an allowed DarkLion inbound address' });
  }
  if (parsed && parsed.domain !== replyDomain()) {
    return res.status(400).json({ error: 'Inbound email reply domain does not match configured reply domain' });
  }
  const uploadedAttachments = normalizeUploadedFiles(req.files);
  const declaredAttachments = parseJsonMaybe(body.attachments, body.attachments) || body.files || [];
  const fromEmail = firstAddress(body.from || body.sender || body.envelope?.from || body.Sender);
  const mailgunSender = firstAddress(body.sender || body.Sender || body.envelope?.from);
  const mailgunSenderMatchesFrom = !!mailgunSender && normalizeEmail(mailgunSender) === normalizeEmail(fromEmail);
  const common = {
    fromEmail,
    fromName: body.from_name || body.fromName || body['from-name'] || '',
    subject: body.subject || '',
    text: body['stripped-text'] || body.text || body.text_body || body.plain || body['body-plain'] || '',
    html: body['stripped-html'] || body.html || body.html_body || body['body-html'] || '',
    attachments: uploadedAttachments.length ? uploadedAttachments : declaredAttachments,
    rawHeaders: {
      ...headers,
      spf: body.spf || body.spf_result || body.spfResult || body.authentication?.spf,
      dkim: body.dkim || body.dkim_result || body.dkimResult || body.authentication?.dkim,
      dmarc: body.dmarc || body.dmarc_result || body.dmarcResult || body.authentication?.dmarc,
      authentication_results: body.authentication_results || body.authenticationResults || body.auth_results || body.authResults,
      mailgun_sender: mailgunSender,
      mailgun_sender_matches_from: mailgunSenderMatchesFrom,
      inbound_recipient: recipient,
      original_recipient: originalRecipient,
      inbound_kind: inboundRecipientKind(originalRecipient || recipient),
    },
    providerMessageId: '',
  };
  common.providerMessageId = providerMessageId(body, common, recipient);

  try {
    const result = parsed?.token
      ? await recordInboundReply({ token: parsed.token, ...common })
      : await recordInboundReplyFallback(common);
    res.json(result);
  } catch (err) {
    const status = err.statusCode || err.status || 500;
    if (status >= 500) console.error('[email-replies] inbound error:', err);
    res.status(status).json({ error: err.message || 'Failed to process inbound email reply' });
  }
});

module.exports = router;
