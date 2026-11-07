'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = '1.0';
const RETENTION_YEARS = 7;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Hex(input) {
  const value = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(value).digest('hex');
}

function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const now = Date.now();
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function retainUntilDate(from = new Date()) {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() + RETENTION_YEARS);
  return d;
}

function buildCanonicalEvent(input = {}) {
  const occurredAt = input.occurred_at || input.occurredAt || new Date().toISOString();
  const recordedAt = input.recorded_at || input.recordedAt || new Date().toISOString();
  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: input.event_id || input.eventId || uuidv7(),
    event_type: input.event_type || input.eventType || 'message.created',
    occurred_at: new Date(occurredAt).toISOString(),
    recorded_at: new Date(recordedAt).toISOString(),
    firm_timezone: input.firm_timezone || input.firmTimezone || 'UTC',
    firm_id: Number(input.firm_id || input.firmId || 0),
    communication_scope: input.communication_scope || input.communicationScope || 'client',
    channel: input.channel || 'portal',
    conversation: {
      type: input.conversation?.type || 'client_thread',
      source_id: String(input.conversation?.source_id || input.conversation?.sourceId || ''),
      subject_or_title: input.conversation?.subject_or_title || input.conversation?.subjectOrTitle || '',
    },
    message: {
      source_id: String(input.message?.source_id || input.message?.sourceId || ''),
      sender_type: input.message?.sender_type || input.message?.senderType || 'staff',
      sender_source_id: String(input.message?.sender_source_id || input.message?.senderSourceId || ''),
      body: input.message?.body ?? '',
      is_internal: !!input.message?.is_internal || !!input.message?.isInternal,
      provider_message_id: input.message?.provider_message_id || input.message?.providerMessageId || '',
      provider_status: input.message?.provider_status || input.message?.providerStatus || '',
    },
    participants_at_event: Array.isArray(input.participants_at_event || input.participantsAtEvent)
      ? (input.participants_at_event || input.participantsAtEvent)
      : [],
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    source_metadata: input.source_metadata || input.sourceMetadata || {},
  };
  event.content_sha256 = sha256Hex(stableStringify(event));
  return event;
}

function sourceKeyForEvent(event) {
  return [
    event.firm_id,
    event.event_type,
    event.channel,
    event.conversation?.type || '',
    event.conversation?.source_id || '',
    event.message?.source_id || '',
    event.occurred_at,
    event.content_sha256,
  ].join(':');
}

function eventObjectKey(event) {
  const day = String(event.occurred_at).slice(0, 10);
  return `events/firm/${event.firm_id}/${day}/${event.event_id}.json`;
}

function exportObjectPrefix(firmId, exportId, when = new Date()) {
  const yyyy = when.getUTCFullYear();
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  return `exports/${firmId}/${yyyy}/${mm}/${exportId}`;
}

module.exports = {
  SCHEMA_VERSION,
  RETENTION_YEARS,
  stableStringify,
  sha256Hex,
  uuidv7,
  retainUntilDate,
  buildCanonicalEvent,
  sourceKeyForEvent,
  eventObjectKey,
  exportObjectPrefix,
};
