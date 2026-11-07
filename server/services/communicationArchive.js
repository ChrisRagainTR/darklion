'use strict';

const { pool } = require('../db');
const {
  buildCanonicalEvent,
  sourceKeyForEvent,
  eventObjectKey,
  exportObjectPrefix,
  uuidv7,
  sha256Hex,
  stableStringify,
  SCHEMA_VERSION,
  RETENTION_YEARS,
} = require('./communicationArchiveCanonical');
const {
  archiveConfigured,
  putImmutableObjectWithOptionalLocalFallback,
  getImmutableObject,
  getSignedArchiveDownloadUrl,
  archiveBucket,
} = require('./communicationArchiveStorage');
const { decrypt } = require('../utils/encryption');
const { downloadFile } = require('./s3');
const { signPayload } = require('./communicationArchiveSigning');
const { ZipArchive } = require('archiver');

function failClosedEnabled() {
  if (process.env.COMMUNICATION_ARCHIVE_FAIL_CLOSED === 'false') return false;
  if (process.env.COMMUNICATION_ARCHIVE_FAIL_CLOSED === 'true') return true;
  // The archive is optional. Once a bucket is configured, sends stop if capture fails.
  return archiveConfigured();
}

async function insertReceipt({ event, sourceKey, objectMeta, status = 'archived', error = null, requestedBy = null }) {
  const { rows } = await pool.query(
    `INSERT INTO communication_archive_events (
       event_id, firm_id, source_key, event_type, communication_scope, channel,
       conversation_type, conversation_source_id, message_source_id, occurred_at,
       content_sha256, archive_bucket, archive_object_key, archive_version_id,
       retain_until, object_lock_mode, status, error_text, payload_json, requested_by_staff_user_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
     )
     ON CONFLICT (firm_id, source_key) DO UPDATE SET
       status = EXCLUDED.status,
       error_text = EXCLUDED.error_text,
       archive_bucket = EXCLUDED.archive_bucket,
       archive_object_key = EXCLUDED.archive_object_key,
       object_lock_mode = EXCLUDED.object_lock_mode,
       payload_json = EXCLUDED.payload_json,
       content_sha256 = EXCLUDED.content_sha256,
       archive_version_id = COALESCE(EXCLUDED.archive_version_id, communication_archive_events.archive_version_id),
       retain_until = COALESCE(EXCLUDED.retain_until, communication_archive_events.retain_until),
       updated_at = NOW()
     RETURNING *`,
    [
      event.event_id,
      event.firm_id,
      sourceKey,
      event.event_type,
      event.communication_scope,
      event.channel,
      event.conversation?.type || '',
      event.conversation?.source_id || '',
      event.message?.source_id || '',
      event.occurred_at,
      event.content_sha256,
      objectMeta?.bucket || archiveBucket() || 'unconfigured',
      objectMeta?.key || eventObjectKey(event),
      objectMeta?.versionId || null,
      objectMeta?.retainUntilDate || null,
      objectMeta?.objectLockMode || 'NONE',
      status,
      error,
      JSON.stringify(event),
      requestedBy,
    ]
  );
  return rows[0];
}

async function enqueueOutbox({ firmId, sourceKey, event, error = null }) {
  await pool.query(
    `INSERT INTO communication_archive_outbox (firm_id, source_key, event_id, payload_json, status, last_error, next_attempt_at)
     VALUES ($1,$2,$3,$4,'pending',$5,NOW())
     ON CONFLICT (firm_id, source_key) DO UPDATE SET
       payload_json = EXCLUDED.payload_json,
       status = 'pending',
       last_error = EXCLUDED.last_error,
       attempt_count = communication_archive_outbox.attempt_count + 1,
       next_attempt_at = NOW(),
       updated_at = NOW()`,
    [firmId, sourceKey, event.event_id, JSON.stringify(event), error]
  );
}

function safeArchiveFilename(name = 'attachment') {
  return String(name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'attachment';
}

async function archiveEventAttachments(event) {
  const archived = [];
  for (const attachment of (event.attachments || [])) {
    if (attachment.archive_object_key && attachment.archive_version_id) {
      archived.push(attachment);
      continue;
    }
    const storageKey = attachment.storage_key || attachment.storageKey || '';
    const sourceBucket = attachment.storage_bucket
      || attachment.storageBucket
      || attachment.metadata?.bucket
      || process.env.AWS_S3_BUCKET
      || '';
    if (!storageKey || !sourceBucket) {
      archived.push({ ...attachment, missing_binary: true });
      continue;
    }
    const body = await downloadFile({ key: storageKey, bucket: sourceBucket });
    const attachmentId = attachment.attachment_id || attachment.document_id || archived.length + 1;
    const archiveKey = `attachments/firm/${event.firm_id}/${event.event_id}/${attachmentId}-${safeArchiveFilename(attachment.file_name)}`;
    const object = await putImmutableObjectWithOptionalLocalFallback({
      key: archiveKey,
      body,
      contentType: attachment.content_type || 'application/octet-stream',
      metadata: {
        firm_id: event.firm_id,
        event_id: event.event_id,
        attachment_id: attachmentId,
        source_bucket: sourceBucket,
        source_key: storageKey,
      },
    });
    archived.push({
      ...attachment,
      storage_bucket: sourceBucket,
      storage_key: storageKey,
      sha256: object.checksumSha256,
      archive_bucket: object.bucket,
      archive_object_key: object.key,
      archive_version_id: object.versionId,
      archive_retain_until: object.retainUntilDate,
      missing_binary: false,
    });
  }
  return archived;
}

async function captureEvent(input = {}, options = {}) {
  let event = buildCanonicalEvent(input);
  const sourceKey = input.source_key || sourceKeyForEvent(event);

  // Existing receipt short-circuit.
  const existing = await pool.query(
    `SELECT * FROM communication_archive_events WHERE firm_id = $1 AND source_key = $2 LIMIT 1`,
    [event.firm_id, sourceKey]
  );
  if (existing.rows[0]?.status === 'archived' && existing.rows[0].archive_version_id) {
    return { event, receipt: existing.rows[0], alreadyArchived: true };
  }

  if (existing.rows[0]?.event_id) {
    event.event_id = existing.rows[0].event_id;
  }

  try {
    const attachments = await archiveEventAttachments(event);
    event = buildCanonicalEvent({ ...event, event_id: event.event_id, attachments });
    const objectKey = eventObjectKey(event);
    const objectMeta = await putImmutableObjectWithOptionalLocalFallback({
      key: objectKey,
      body: stableStringify(event),
      contentType: 'application/json',
      metadata: {
        firm_id: event.firm_id,
        event_type: event.event_type,
        content_sha256: event.content_sha256,
      },
    });
    if (objectMeta.localFallback) {
      // Persist local body for offline/dev verification only.
      event._local_body = objectMeta.body.toString('utf8');
    }
    const receipt = await insertReceipt({
      event,
      sourceKey,
      objectMeta,
      status: 'archived',
      requestedBy: options.requestedByStaffUserId || null,
    });
    await pool.query(
      `UPDATE communication_archive_outbox
       SET status = 'archived', updated_at = NOW()
       WHERE firm_id = $1 AND source_key = $2`,
      [event.firm_id, sourceKey]
    ).catch(() => {});
    return { event, receipt, alreadyArchived: !!objectMeta.alreadyExisted };
  } catch (error) {
    const objectKey = eventObjectKey(event);
    await enqueueOutbox({ firmId: event.firm_id, sourceKey, event, error: error.message });
    await insertReceipt({
      event,
      sourceKey,
      objectMeta: { bucket: archiveBucket() || 'unconfigured', key: objectKey },
      status: 'pending',
      error: error.message,
      requestedBy: options.requestedByStaffUserId || null,
    }).catch(() => {});
    if (options.allowQueue || !failClosedEnabled()) {
      return { event, queued: true, error };
    }
    const err = new Error(`Communication archive capture failed: ${error.message}`);
    err.statusCode = error.statusCode || 503;
    err.code = error.code || 'ARCHIVE_CAPTURE_FAILED';
    throw err;
  }
}

async function loadClientMessageContext(messageId, firmId) {
  const { rows } = await pool.query(
    `SELECT m.*, mt.firm_id, mt.person_id, mt.subject, mt.staff_user_id, mt.status AS thread_status,
            p.first_name, p.last_name, p.email
     FROM messages m
     JOIN message_threads mt ON mt.id = m.thread_id
     LEFT JOIN people p ON p.id = mt.person_id
     WHERE m.id = $1 AND mt.firm_id = $2
     LIMIT 1`,
    [messageId, firmId]
  );
  return rows[0] || null;
}

async function loadClientAttachments(messageId) {
  const { rows } = await pool.query(
    `SELECT ma.id AS attachment_id, d.id AS document_id, d.display_name, d.mime_type, d.size_bytes, d.s3_key, d.s3_bucket
     FROM message_attachments ma
     JOIN documents d ON d.id = ma.document_id
     WHERE ma.message_id = $1
     ORDER BY ma.id ASC`,
    [messageId]
  );
  return rows.map((row) => ({
    attachment_id: row.attachment_id,
    document_id: row.document_id,
    file_name: row.display_name,
    content_type: row.mime_type,
    byte_size: row.size_bytes,
    storage_key: row.s3_key,
    storage_bucket: row.s3_bucket,
  }));
}

async function archiveClientMessageCreated({ firmId, messageId, requestedByStaffUserId = null, allowQueue = false, extraMetadata = {} }) {
  const row = await loadClientMessageContext(messageId, firmId);
  if (!row) {
    const err = new Error('Client message not found for archive capture.');
    err.statusCode = 404;
    throw err;
  }
  const attachments = await loadClientAttachments(messageId);
  return captureEvent({
    firm_id: firmId,
    event_type: 'message.created',
    communication_scope: 'client',
    channel: row.channel || 'portal',
    occurred_at: row.created_at,
    conversation: {
      type: 'client_thread',
      source_id: row.thread_id,
      subject_or_title: row.subject || '',
    },
    message: {
      source_id: row.id,
      sender_type: row.sender_type,
      sender_source_id: row.sender_id,
      body: row.body || '',
      is_internal: !!row.is_internal,
      provider_message_id: row.provider_message_id || '',
      provider_status: row.provider_status || '',
    },
    participants_at_event: [
      { role: 'person', source_id: row.person_id, name: `${row.first_name || ''} ${row.last_name || ''}`.trim(), email: row.email || '' },
      { role: 'staff_owner', source_id: row.staff_user_id },
    ],
    attachments,
    source_metadata: {
      thread_status: row.thread_status,
      message_type: row.message_type || 'message',
      is_system_message: !!row.is_system_message,
      is_emma_draft: !!row.is_emma_draft,
      ...extraMetadata,
    },
  }, { requestedByStaffUserId, allowQueue });
}

async function archiveClientMessageCreatedFailClosed(args) {
  try {
    return await archiveClientMessageCreated({ ...args, allowQueue: false });
  } catch (error) {
    await pool.query(
      `UPDATE messages
       SET removed_at = COALESCE(removed_at, NOW()),
           removal_reason = COALESCE(NULLIF(removal_reason, ''), 'immutable_archive_capture_failed')
       WHERE id = $1`,
      [args.messageId]
    ).catch(() => {});
    throw error;
  }
}

async function archiveClientMessageRemoved({ firmId, messageId, removedByStaffUserId, allowQueue = false }) {
  const row = await loadClientMessageContext(messageId, firmId);
  if (!row) {
    const err = new Error('Client message not found for archive removal event.');
    err.statusCode = 404;
    throw err;
  }
  return captureEvent({
    firm_id: firmId,
    event_type: 'message.removed',
    communication_scope: 'client',
    channel: row.channel || 'portal',
    occurred_at: new Date().toISOString(),
    conversation: {
      type: 'client_thread',
      source_id: row.thread_id,
      subject_or_title: row.subject || '',
    },
    message: {
      source_id: row.id,
      sender_type: row.sender_type,
      sender_source_id: row.sender_id,
      body: row.body || '',
      is_internal: !!row.is_internal,
      provider_message_id: row.provider_message_id || '',
      provider_status: row.provider_status || '',
    },
    source_metadata: {
      removed_by_staff_user_id: removedByStaffUserId,
      removed_at: new Date().toISOString(),
      prior_created_at: row.created_at,
    },
  }, { requestedByStaffUserId: removedByStaffUserId, allowQueue });
}

async function loadTeamChatMessage(messageId, firmId) {
  const { rows } = await pool.query(
    `SELECT msg.*, c.conversation_type, c.title
     FROM native_team_chat_messages msg
     JOIN native_team_chat_conversations c ON c.id = msg.conversation_id AND c.firm_id = msg.firm_id
     WHERE msg.id = $1 AND msg.firm_id = $2
     LIMIT 1`,
    [messageId, firmId]
  );
  return rows[0] || null;
}

async function loadTeamChatAttachments(messageId, firmId) {
  const { rows } = await pool.query(
    `SELECT id, storage_key, file_name, content_type, byte_size, sha256, metadata
     FROM native_team_chat_attachments
     WHERE firm_id = $1 AND message_id = $2
     ORDER BY id ASC`,
    [firmId, messageId]
  );
  return rows.map((row) => ({
    attachment_id: row.id,
    file_name: row.file_name,
    content_type: row.content_type,
    byte_size: row.byte_size,
    storage_key: row.storage_key,
    storage_bucket: row.metadata?.bucket || process.env.AWS_S3_BUCKET || '',
    sha256: row.sha256,
    metadata: row.metadata || {},
    missing_binary: !row.storage_key,
  }));
}

async function archiveTeamChatMessageCreated({ firmId, messageId, requestedByStaffUserId = null, allowQueue = false }) {
  const row = await loadTeamChatMessage(messageId, firmId);
  if (!row) {
    const err = new Error('Team Chat message not found for archive capture.');
    err.statusCode = 404;
    throw err;
  }
  const attachments = await loadTeamChatAttachments(messageId, firmId);
  const body = row.body_encrypted ? (decrypt(row.body_encrypted) || '') : '';
  return captureEvent({
    firm_id: firmId,
    event_type: 'message.created',
    communication_scope: 'internal',
    channel: 'team_chat',
    occurred_at: row.created_at,
    conversation: {
      type: row.conversation_type === 'dm' ? 'team_dm' : 'team_group',
      source_id: row.conversation_id,
      subject_or_title: row.title || '',
    },
    message: {
      source_id: row.id,
      sender_type: 'staff',
      sender_source_id: row.sender_staff_user_id,
      body,
      is_internal: true,
      provider_message_id: row.client_nonce || '',
      provider_status: '',
    },
    attachments,
    source_metadata: {
      immutable_sha256: row.immutable_sha256,
      retained_at: row.retained_at,
      visible_until: row.visible_until,
      metadata: row.metadata || {},
    },
  }, { requestedByStaffUserId, allowQueue });
}

async function archiveTeamChatMessageCreatedFailClosed(args) {
  try {
    return await archiveTeamChatMessageCreated({ ...args, allowQueue: false });
  } catch (error) {
    await pool.query(
      `UPDATE native_team_chat_messages
       SET removed_at = COALESCE(removed_at, NOW())
       WHERE id = $1 AND firm_id = $2`,
      [args.messageId, args.firmId]
    ).catch(() => {});
    throw error;
  }
}

async function archiveTeamChatMessageEdited({ firmId, messageId, requestedByStaffUserId = null, allowQueue = false }) {
  const row = await loadTeamChatMessage(messageId, firmId);
  if (!row) {
    const err = new Error('Team Chat message not found for archive edit event.');
    err.statusCode = 404;
    throw err;
  }
  const body = row.body_encrypted ? (decrypt(row.body_encrypted) || '') : '';
  const original = row.original_body_encrypted ? (decrypt(row.original_body_encrypted) || '') : '';
  return captureEvent({
    firm_id: firmId,
    event_type: 'message.edited',
    communication_scope: 'internal',
    channel: 'team_chat',
    occurred_at: row.edited_at || new Date().toISOString(),
    conversation: {
      type: row.conversation_type === 'dm' ? 'team_dm' : 'team_group',
      source_id: row.conversation_id,
      subject_or_title: row.title || '',
    },
    message: {
      source_id: row.id,
      sender_type: 'staff',
      sender_source_id: row.sender_staff_user_id,
      body,
      is_internal: true,
    },
    source_metadata: {
      edited_by_staff_user_id: row.edited_by_staff_user_id,
      edit_count: row.edit_count,
      original_body: original,
    },
  }, { requestedByStaffUserId, allowQueue });
}

async function archiveTeamChatMessageRemoved({ firmId, messageId, requestedByStaffUserId = null, allowQueue = false }) {
  const row = await loadTeamChatMessage(messageId, firmId);
  if (!row) {
    const err = new Error('Team Chat message not found for archive removal event.');
    err.statusCode = 404;
    throw err;
  }
  const body = row.body_encrypted ? (decrypt(row.body_encrypted) || '') : '';
  return captureEvent({
    firm_id: firmId,
    event_type: 'message.removed',
    communication_scope: 'internal',
    channel: 'team_chat',
    occurred_at: row.removed_at || row.deleted_at || new Date().toISOString(),
    conversation: {
      type: row.conversation_type === 'dm' ? 'team_dm' : 'team_group',
      source_id: row.conversation_id,
      subject_or_title: row.title || '',
    },
    message: {
      source_id: row.id,
      sender_type: 'staff',
      sender_source_id: row.sender_staff_user_id,
      body,
      is_internal: true,
    },
    source_metadata: {
      removed_by_staff_user_id: row.removed_by_staff_user_id || row.deleted_by_staff_user_id || requestedByStaffUserId,
    },
  }, { requestedByStaffUserId, allowQueue });
}

function localMidnightToUtc(dateText, timezone) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Dates must use YYYY-MM-DD.');
  const [, year, month, day] = match;
  const desiredUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  let candidate = new Date(desiredUtc);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second), 0
    );
    candidate = new Date(candidate.getTime() + (desiredUtc - represented));
  }
  return candidate;
}

function addCalendarDay(dateText) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function parseDateRange({ startDate, endDate, timezone = 'UTC' }) {
  if (!startDate || !endDate) {
    const err = new Error('startDate and endDate are required (YYYY-MM-DD).');
    err.statusCode = 400;
    throw err;
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); }
  catch (_) {
    const err = new Error('Invalid IANA timezone.');
    err.statusCode = 400;
    throw err;
  }
  let start;
  let end;
  try {
    start = localMidnightToUtc(startDate, timezone);
    end = localMidnightToUtc(addCalendarDay(endDate), timezone);
  } catch (error) {
    const err = new Error(error.message || 'Invalid date range.');
    err.statusCode = 400;
    throw err;
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    const err = new Error('Invalid date range.');
    err.statusCode = 400;
    throw err;
  }
  return { start, end, timezone: timezone || 'UTC' };
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map((row) => columns.map((col) => csvEscape(row[col])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

async function buildZipBuffer(fileMap) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, body] of Object.entries(fileMap)) archive.append(body, { name });
    archive.finalize().catch(reject);
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}

async function createExport({ firmId, staffUserId, startDate, endDate, timezone = 'UTC', channels = null, includeAttachments = true }) {
  const range = parseDateRange({ startDate, endDate, timezone });
  const exportId = uuidv7();
  const prefix = exportObjectPrefix(firmId, exportId);

  const params = [firmId, range.start.toISOString(), range.end.toISOString()];
  let channelSql = '';
  if (Array.isArray(channels) && channels.length) {
    params.push(channels);
    channelSql = ` AND channel = ANY($${params.length}::text[])`;
  }

  const { rows: events } = await pool.query(
    `SELECT *
     FROM communication_archive_events
     WHERE firm_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
       AND status = 'archived'
       ${channelSql}
     ORDER BY occurred_at ASC, event_id ASC`,
    params
  );

  const exceptions = [];
  const hydrationResults = events.map((row) => {
    try {
      const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
      if (!payload) throw new Error('Archive receipt payload is missing.');
      if (!payload.content_sha256 || payload.content_sha256 !== row.content_sha256) {
        throw new Error('Archive event content hash does not match its receipt.');
      }
      const attachmentExceptions = (payload.attachments || [])
        .filter((att) => !att.storage_key)
        .map((att) => ({
          event_id: row.event_id,
          exception_type: 'attachment.missing',
          detail: `Attachment ${att.attachment_id || att.file_name || 'unknown'} has no storage key`,
        }));
      return { hydrated: { row, payload }, exceptions: attachmentExceptions };
    } catch (error) {
      return {
        hydrated: null,
        exceptions: [{
          event_id: row.event_id,
          exception_type: 'missing_invalid_or_unreadable_event_object',
          detail: error.message,
        }],
      };
    }
  });
  const hydrated = hydrationResults.map((result) => result.hydrated).filter(Boolean);
  for (const result of hydrationResults) exceptions.push(...result.exceptions);

  const communications = hydrated.map(({ payload }) => ({
    occurred_at_utc: payload.occurred_at,
    firm_timezone: payload.firm_timezone,
    scope: payload.communication_scope,
    channel: payload.channel,
    event_type: payload.event_type,
    conversation_type: payload.conversation?.type || '',
    conversation_id: payload.conversation?.source_id || '',
    conversation_title: payload.conversation?.subject_or_title || '',
    message_id: payload.message?.source_id || '',
    sender_type: payload.message?.sender_type || '',
    sender_id: payload.message?.sender_source_id || '',
    is_internal: payload.message?.is_internal ? 'true' : 'false',
    body: payload.message?.body || '',
    attachment_count: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
    content_sha256: payload.content_sha256 || '',
    archive_object_key: eventObjectKey(payload),
  }));

  const conversationsMap = new Map();
  const participants = [];
  for (const { payload } of hydrated) {
    const key = `${payload.conversation?.type}:${payload.conversation?.source_id}`;
    if (!conversationsMap.has(key)) {
      conversationsMap.set(key, {
        conversation_type: payload.conversation?.type || '',
        conversation_id: payload.conversation?.source_id || '',
        title: payload.conversation?.subject_or_title || '',
        channel: payload.channel,
        scope: payload.communication_scope,
      });
    }
    for (const participant of (payload.participants_at_event || [])) {
      participants.push({
        event_id: payload.event_id,
        conversation_id: payload.conversation?.source_id || '',
        ...participant,
      });
    }
  }

  const attachmentsManifest = [];
  for (const { payload } of hydrated) {
    for (const att of (payload.attachments || [])) {
      attachmentsManifest.push({
        event_id: payload.event_id,
        message_id: payload.message?.source_id || '',
        attachment_id: att.attachment_id || '',
        file_name: att.file_name || '',
        content_type: att.content_type || '',
        byte_size: att.byte_size || '',
        storage_bucket: att.storage_bucket || '',
        storage_key: att.storage_key || '',
        sha256: att.sha256 || '',
        missing_binary: att.missing_binary || !att.storage_key ? 'true' : 'false',
      });
    }
  }

  const request = {
    export_id: exportId,
    firm_id: firmId,
    requested_by_staff_user_id: staffUserId,
    start_date: startDate,
    end_date: endDate,
    timezone: range.timezone,
    inclusive_start_utc: range.start.toISOString(),
    exclusive_end_utc: range.end.toISOString(),
    channels: channels || 'all',
    include_attachments: !!includeAttachments,
    schema_version: SCHEMA_VERSION,
    retention_years: RETENTION_YEARS,
    generated_at: new Date().toISOString(),
  };

  const eventsNdjson = hydrated.map(({ payload }) => stableStringify(payload)).join('\n') + (hydrated.length ? '\n' : '');
  const communicationsCsv = toCsv(communications, [
    'occurred_at_utc', 'firm_timezone', 'scope', 'channel', 'event_type', 'conversation_type', 'conversation_id',
    'conversation_title', 'message_id', 'sender_type', 'sender_id', 'is_internal', 'body', 'attachment_count',
    'content_sha256', 'archive_object_key',
  ]);
  const attachmentsCsv = toCsv(attachmentsManifest, [
    'event_id', 'message_id', 'attachment_id', 'file_name', 'content_type', 'byte_size', 'storage_bucket',
    'storage_key', 'sha256', 'missing_binary',
  ]);
  const exceptionsCsv = toCsv(exceptions, ['event_id', 'exception_type', 'detail']);
  const conversationsJson = stableStringify([...conversationsMap.values()]);
  const participantsJson = stableStringify(participants);
  const readme = [
    'DarkLion Communications Archive Export',
    `Export ID: ${exportId}`,
    `Firm ID: ${firmId}`,
    `Range: ${startDate} to ${endDate} (${range.timezone})`,
    'Date semantics: inclusive start date, exclusive end date + 1 day.',
    'Source of truth: events.ndjson + checksums/signatures.',
    'Do not treat a modified downloaded copy as authoritative.',
    '',
  ].join('\n');

  const files = {
    'README.txt': Buffer.from(readme, 'utf8'),
    'request.json': Buffer.from(stableStringify(request), 'utf8'),
    'communications.csv': Buffer.from(communicationsCsv, 'utf8'),
    'events.ndjson': Buffer.from(eventsNdjson, 'utf8'),
    'conversations.json': Buffer.from(conversationsJson, 'utf8'),
    'participants.json': Buffer.from(participantsJson, 'utf8'),
    'attachments-manifest.csv': Buffer.from(attachmentsCsv, 'utf8'),
    'exceptions.csv': Buffer.from(exceptionsCsv, 'utf8'),
  };

  if (includeAttachments) {
    const eventsById = new Map(hydrated.map(({ payload }) => [payload.event_id, payload]));
    const attachmentResults = await mapWithConcurrency(attachmentsManifest, 16, async (item) => {
      const event = eventsById.get(item.event_id);
      const attachment = event?.attachments?.find((att) => String(att.attachment_id || att.document_id || '') === String(item.attachment_id));
      if (!attachment?.archive_object_key || !attachment?.archive_version_id) return null;
      try {
        const object = await getImmutableObject({
          key: attachment.archive_object_key,
          versionId: attachment.archive_version_id,
        });
        if (attachment.sha256 && sha256Hex(object.body) !== attachment.sha256) {
          throw new Error('Attachment checksum mismatch.');
        }
        const exportName = `attachments/${item.event_id}/${safeArchiveFilename(item.file_name)}`;
        return { exportName, body: object.body, exception: null };
      } catch (error) {
        return {
          exportName: null,
          body: null,
          exception: {
            event_id: item.event_id,
            exception_type: 'attachment_archive_read_failed',
            detail: `${item.file_name || item.attachment_id}: ${error.message}`,
          },
        };
      }
    });
    for (const result of attachmentResults.filter(Boolean)) {
      if (result.exception) exceptions.push(result.exception);
      else files[result.exportName] = result.body;
    }
    files['exceptions.csv'] = Buffer.from(toCsv(exceptions, ['event_id', 'exception_type', 'detail']), 'utf8');
  }

  // The ZIP is the retained export artifact. Its members are checksummed here,
  // but are not redundantly uploaded as thousands of separate export objects.
  const storedFiles = Object.entries(files).map(([name, body]) => ({
    name,
    key: null,
    versionId: null,
    checksumSha256: sha256Hex(body),
    retainUntilDate: null,
    objectLockMode: null,
  }));
  const checksumLines = storedFiles.map((file) => `${file.checksumSha256}  ${file.name}`);

  const checksumsBody = Buffer.from(checksumLines.join('\n') + '\n', 'utf8');
  const checksumObject = await putImmutableObjectWithOptionalLocalFallback({
    key: `${prefix}/checksums.sha256`,
    body: checksumsBody,
    contentType: 'text/plain',
    metadata: { export_id: exportId, firm_id: firmId, file_name: 'checksums.sha256' },
  });
  storedFiles.push({ name: 'checksums.sha256', ...checksumObject });

  const rootHash = sha256Hex(checksumLines.join('\n'));
  const signaturePayload = {
    export_id: exportId,
    firm_id: firmId,
    root_hash: rootHash,
    file_count: Object.keys(files).length,
    event_count: hydrated.length,
    exception_count: exceptions.length,
    inclusive_start_utc: request.inclusive_start_utc,
    exclusive_end_utc: request.exclusive_end_utc,
    timezone: request.timezone,
    checksums: checksumLines,
    generated_at: request.generated_at,
  };
  const signatureProof = await signPayload(signaturePayload);
  const signature = signatureProof.signature_base64;
  const signatureBody = Buffer.from(stableStringify(signatureProof), 'utf8');
  const signatureObject = await putImmutableObjectWithOptionalLocalFallback({
    key: `${prefix}/manifest.sig`,
    body: signatureBody,
    contentType: 'application/json',
    metadata: { export_id: exportId, firm_id: firmId, file_name: 'manifest.sig' },
  });
  storedFiles.push({ name: 'manifest.sig', ...signatureObject });

  const verification = {
    export_id: exportId,
    status: exceptions.length ? 'passed_with_exceptions' : 'passed',
    event_count: hydrated.length,
    exception_count: exceptions.length,
    root_hash: rootHash,
    signature_algorithm: signatureProof.algorithm,
    signing_key_id: signatureProof.key_id,
    verified_at: new Date().toISOString(),
    files: storedFiles.map((f) => ({
      name: f.name,
      key: f.key,
      version_id: f.versionId,
      checksum_sha256: f.checksumSha256,
      retain_until: f.retainUntilDate,
      object_lock_mode: f.objectLockMode,
    })),
  };
  const verificationBody = Buffer.from(stableStringify(verification), 'utf8');
  const verificationObject = await putImmutableObjectWithOptionalLocalFallback({
    key: `${prefix}/verification-report.json`,
    body: verificationBody,
    contentType: 'application/json',
    metadata: { export_id: exportId, firm_id: firmId, file_name: 'verification-report.json' },
  });
  storedFiles.push({ name: 'verification-report.json', ...verificationObject });

  const manifest = {
    ...request,
    event_count: hydrated.length,
    exception_count: exceptions.length,
    root_hash: rootHash,
    signature_algorithm: signatureProof.algorithm,
    signing_key_id: signatureProof.key_id,
    signature_base64: signature,
    files: verification.files,
  };
  const manifestBody = Buffer.from(stableStringify(manifest), 'utf8');
  const manifestObject = await putImmutableObjectWithOptionalLocalFallback({
    key: `${prefix}/manifest.json`,
    body: manifestBody,
    contentType: 'application/json',
    metadata: { export_id: exportId, firm_id: firmId, file_name: 'manifest.json' },
  });
  storedFiles.push({ name: 'manifest.json', ...manifestObject });

  const zipFiles = {
    ...files,
    'checksums.sha256': checksumsBody,
    'manifest.sig': signatureBody,
    'verification-report.json': verificationBody,
    'manifest.json': manifestBody,
  };
  const zipBody = await buildZipBuffer(zipFiles);
  const zipObject = await putImmutableObjectWithOptionalLocalFallback({
    key: `${prefix}/export.zip`,
    body: zipBody,
    contentType: 'application/zip',
    metadata: { export_id: exportId, firm_id: firmId, file_name: 'export.zip' },
  });
  storedFiles.push({ name: 'export.zip', ...zipObject });

  const { rows } = await pool.query(
    `INSERT INTO communication_archive_exports (
       export_id, firm_id, requested_by_staff_user_id, start_date, end_date, timezone,
       inclusive_start_at, exclusive_end_at, status, event_count, exception_count,
       archive_bucket, archive_prefix, manifest_object_key, manifest_version_id,
       root_hash, signature, request_json, verification_json
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
     ) RETURNING *`,
    [
      exportId,
      firmId,
      staffUserId,
      startDate,
      endDate,
      range.timezone,
      range.start.toISOString(),
      range.end.toISOString(),
      verification.status,
      hydrated.length,
      exceptions.length,
      archiveBucket() || 'local-dev-archive',
      prefix,
      manifestObject.key,
      manifestObject.versionId,
      rootHash,
      signature,
      JSON.stringify(request),
      JSON.stringify(verification),
    ]
  );

  await captureEvent({
    firm_id: firmId,
    event_type: 'export.generated',
    communication_scope: 'internal',
    channel: 'system',
    conversation: { type: 'export', source_id: exportId, subject_or_title: `Export ${startDate} to ${endDate}` },
    message: {
      source_id: exportId,
      sender_type: 'staff',
      sender_source_id: staffUserId,
      body: `Generated communications export ${exportId}`,
      is_internal: true,
    },
    source_metadata: {
      start_date: startDate,
      end_date: endDate,
      event_count: hydrated.length,
      exception_count: exceptions.length,
      root_hash: rootHash,
    },
  }, { requestedByStaffUserId: staffUserId, allowQueue: true }).catch(() => {});

  await pool.query(
    `INSERT INTO communication_archive_access_events
       (firm_id, export_id, staff_user_id, action, detail)
     VALUES ($1,$2,$3,'export.generated',$4)`,
    [firmId, exportId, staffUserId, JSON.stringify({ event_count: hydrated.length, exception_count: exceptions.length })]
  );

  return rows[0];
}

async function listExports(firmId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT export_id, firm_id, requested_by_staff_user_id, start_date, end_date, timezone,
            status, event_count, exception_count, archive_prefix, root_hash, created_at
     FROM communication_archive_exports
     WHERE firm_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [firmId, Math.min(Number(limit) || 50, 200)]
  );
  return rows;
}

async function getExport(firmId, exportId) {
  const { rows } = await pool.query(
    `SELECT * FROM communication_archive_exports WHERE firm_id = $1 AND export_id = $2 LIMIT 1`,
    [firmId, exportId]
  );
  return rows[0] || null;
}

async function getExportDownload({ firmId, exportId, staffUserId, fileName = 'export.zip' }) {
  const exp = await getExport(firmId, exportId);
  if (!exp) {
    const err = new Error('Export not found.');
    err.statusCode = 404;
    throw err;
  }
  const allowedFiles = new Set(['export.zip', 'manifest.json', 'manifest.sig', 'verification-report.json', 'checksums.sha256']);
  if (!allowedFiles.has(fileName)) {
    const err = new Error('Unsupported export file.');
    err.statusCode = 400;
    throw err;
  }
  const key = `${exp.archive_prefix}/${fileName}`;
  const url = archiveConfigured()
    ? await getSignedArchiveDownloadUrl({ key, filename: fileName })
    : null;
  await pool.query(
    `INSERT INTO communication_archive_access_events
       (firm_id, export_id, staff_user_id, action, detail)
     VALUES ($1,$2,$3,'export.downloaded',$4)`,
    [firmId, exportId, staffUserId, JSON.stringify({ file_name: fileName })]
  );
  await captureEvent({
    firm_id: firmId,
    event_type: 'export.downloaded',
    communication_scope: 'internal',
    channel: 'system',
    conversation: { type: 'export', source_id: exportId, subject_or_title: fileName },
    message: {
      source_id: exportId,
      sender_type: 'staff',
      sender_source_id: staffUserId,
      body: `Downloaded ${fileName}`,
      is_internal: true,
    },
  }, { requestedByStaffUserId: staffUserId, allowQueue: true }).catch(() => {});
  return { export: exp, fileName, key, url };
}

async function healthStatus() {
  const pending = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM communication_archive_outbox
     WHERE status = 'pending'`
  );
  const archived = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM communication_archive_events
     WHERE status = 'archived'`
  );
  return {
    configured: archiveConfigured(),
    fail_closed: failClosedEnabled(),
    bucket: archiveBucket() || null,
    pending_outbox: pending.rows[0]?.count || 0,
    archived_events: archived.rows[0]?.count || 0,
    retention_years: RETENTION_YEARS,
    schema_version: SCHEMA_VERSION,
  };
}

module.exports = {
  captureEvent,
  archiveClientMessageCreated,
  archiveClientMessageCreatedFailClosed,
  archiveClientMessageRemoved,
  archiveTeamChatMessageCreated,
  archiveTeamChatMessageCreatedFailClosed,
  archiveTeamChatMessageEdited,
  archiveTeamChatMessageRemoved,
  createExport,
  listExports,
  getExport,
  getExportDownload,
  healthStatus,
  failClosedEnabled,
  buildZipBuffer,
};
