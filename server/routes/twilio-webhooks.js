'use strict';

const { Router } = require('express');
const twilio = require('twilio');
const { pool } = require('../db');
const {
  dispatchInboundSmsNotifications,
  processInboundSms,
} = require('../services/inboundSms');

const router = Router();

function buildWebhookUrl(req) {
  const configuredBase = process.env.TWILIO_WEBHOOK_BASE_URL || process.env.APP_URL;
  const base = configuredBase
    ? configuredBase.replace(/\/+$/, '')
    : `${req.protocol}://${req.get('host')}`;
  return `${base}${req.originalUrl}`;
}

function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.get('X-Twilio-Signature');
  if (!authToken || !signature) return false;
  return twilio.validateRequest(authToken, signature, buildWebhookUrl(req), req.body || {});
}

router.post('/inbound', async (req, res) => {
  res.type('text/xml');

  if (!validateTwilioSignature(req)) {
    return res.status(403).send('<Response></Response>');
  }

  const providerMessageId = String(req.body?.MessageSid || '').trim();
  if (!providerMessageId || !req.body?.From || !req.body?.To) {
    return res.status(400).send('<Response></Response>');
  }

  try {
    const result = await processInboundSms({ pool, payload: req.body });
    dispatchInboundSmsNotifications({ app: req.app, result });

    if (result.matchStatus && result.matchStatus !== 'matched') {
      console.warn(`[twilio-inbound] accepted ${result.matchStatus} message ${providerMessageId}`);
    }
    return res.status(200).send('<Response></Response>');
  } catch (error) {
    console.error(`[twilio-inbound] failed message ${providerMessageId}:`, error.message);
    return res.status(500).send('<Response></Response>');
  }
});

router.post('/status', async (req, res) => {
  if (!validateTwilioSignature(req)) {
    return res.status(403).send('');
  }

  const providerMessageId = String(req.body?.MessageSid || '').trim();
  const providerStatus = String(req.body?.MessageStatus || '').trim().toLowerCase();
  if (!providerMessageId || !providerStatus) {
    return res.status(400).send('');
  }

  try {
    await pool.query(
      `UPDATE messages
          SET provider_status = $1
        WHERE provider_message_id = $2 AND channel = 'sms'`,
      [providerStatus, providerMessageId]
    );
    return res.status(204).send('');
  } catch (error) {
    console.error(`[twilio-status] failed message ${providerMessageId}:`, error.message);
    return res.status(500).send('');
  }
});

module.exports = router;
module.exports.buildWebhookUrl = buildWebhookUrl;
module.exports.validateTwilioSignature = validateTwilioSignature;
