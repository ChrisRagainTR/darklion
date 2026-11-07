'use strict';

const { pool } = require('../db');
const {
  archiveClientMessageCreated,
  archiveTeamChatMessageCreated,
  archiveTeamChatMessageEdited,
  archiveTeamChatMessageRemoved,
  captureEvent,
} = require('./communicationArchive');
const { decrypt } = require('../utils/encryption');

async function forEachBatch(queryPage, handleRow, batchSize) {
  let lastId = 0;
  let sourceCount = 0;
  while (true) {
    const rows = await queryPage(lastId, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) await handleRow(row);
    sourceCount += rows.length;
    lastId = rows[rows.length - 1].id;
  }
  return sourceCount;
}

async function backfillFirm(firmId, { limit: batchSize = 500 } = {}) {
  const summary = {
    firm_id: firmId,
    client_messages_archived: 0,
    team_chat_messages_archived: 0,
    team_chat_edits_archived: 0,
    team_chat_removals_archived: 0,
    legacy_team_chat_archived: 0,
    exceptions: [],
  };

  const clientSourceCount = await forEachBatch(async (lastId, size) => {
    const { rows } = await pool.query(
      `SELECT m.id FROM messages m
       JOIN message_threads mt ON mt.id = m.thread_id
       WHERE mt.firm_id = $1 AND m.id > $2
       ORDER BY m.id ASC LIMIT $3`,
      [firmId, lastId, size]
    );
    return rows;
  }, async (row) => {
    try {
      await archiveClientMessageCreated({ firmId, messageId: row.id, allowQueue: true });
      summary.client_messages_archived += 1;
    } catch (error) {
      summary.exceptions.push({ type: 'client_message', id: row.id, error: error.message });
    }
  }, batchSize);

  const teamSourceCount = await forEachBatch(async (lastId, size) => {
    const { rows } = await pool.query(
      `SELECT id, edited_at, removed_at, deleted_at
       FROM native_team_chat_messages
       WHERE firm_id = $1 AND id > $2
       ORDER BY id ASC LIMIT $3`,
      [firmId, lastId, size]
    );
    return rows;
  }, async (row) => {
    try {
      await archiveTeamChatMessageCreated({ firmId, messageId: row.id, allowQueue: true });
      summary.team_chat_messages_archived += 1;
      if (row.edited_at) {
        await archiveTeamChatMessageEdited({ firmId, messageId: row.id, allowQueue: true });
        summary.team_chat_edits_archived += 1;
      }
      if (row.removed_at || row.deleted_at) {
        await archiveTeamChatMessageRemoved({ firmId, messageId: row.id, allowQueue: true });
        summary.team_chat_removals_archived += 1;
      }
    } catch (error) {
      summary.exceptions.push({ type: 'team_chat_message', id: row.id, error: error.message });
    }
  }, batchSize);

  const missingAttachments = await pool.query(
    `SELECT id, message_id, file_name
     FROM native_team_chat_attachments
     WHERE firm_id = $1 AND (storage_key IS NULL OR storage_key = '')`,
    [firmId]
  );
  for (const row of missingAttachments.rows) {
    try {
      await captureEvent({
        firm_id: firmId,
        event_type: 'attachment.missing',
        communication_scope: 'internal',
        channel: 'team_chat',
        conversation: { type: 'team_group', source_id: '', subject_or_title: '' },
        message: { source_id: row.message_id, sender_type: 'system', sender_source_id: '', body: '', is_internal: true },
        attachments: [{ attachment_id: row.id, file_name: row.file_name, missing_binary: true }],
        source_metadata: { reason: 'storage_key_missing_during_backfill' },
      }, { allowQueue: true });
    } catch (error) {
      summary.exceptions.push({ type: 'missing_attachment', id: row.id, error: error.message });
    }
  }

  const legacySourceCount = await forEachBatch(async (lastId, size) => {
    const { rows } = await pool.query(
      `SELECT m.*, c.telegram_chat_id, c.title, c.chat_type
       FROM team_chat_messages m
       JOIN team_chat_chats c ON c.id = m.chat_id AND c.firm_id = m.firm_id
       WHERE m.firm_id = $1 AND m.id > $2
       ORDER BY m.id ASC LIMIT $3`,
      [firmId, lastId, size]
    );
    return rows;
  }, async (row) => {
    try {
      const body = row.text_encrypted ? (decrypt(row.text_encrypted) || '') : '';
      await captureEvent({
        firm_id: firmId,
        event_type: 'backfill.message.created',
        communication_scope: 'internal',
        channel: 'legacy_telegram',
        occurred_at: row.sent_at || row.created_at,
        conversation: {
          type: 'legacy_chat',
          source_id: row.chat_id,
          subject_or_title: row.title || row.telegram_chat_id || '',
        },
        message: {
          source_id: row.id,
          sender_type: row.sender_staff_user_id ? 'staff' : 'system',
          sender_source_id: row.sender_staff_user_id || row.sender_telegram_user_id || '',
          body,
          is_internal: true,
          provider_message_id: row.telegram_message_id || '',
        },
        source_metadata: {
          chat_type: row.chat_type,
          direction: row.direction,
          message_kind: row.message_kind,
          media_metadata: row.media_metadata || {},
        },
      }, { allowQueue: true });
      summary.legacy_team_chat_archived += 1;
    } catch (error) {
      summary.exceptions.push({ type: 'legacy_team_chat', id: row.id, error: error.message });
    }
  }, batchSize);

  await pool.query(
    `INSERT INTO communication_archive_reconciliation_runs
       (firm_id, run_type, status, source_count, archived_count, exception_count, detail_json)
     VALUES ($1,'backfill',$2,$3,$4,$5,$6)`,
    [
      firmId,
      summary.exceptions.length ? 'passed_with_exceptions' : 'passed',
      clientSourceCount + teamSourceCount + legacySourceCount,
      summary.client_messages_archived + summary.team_chat_messages_archived + summary.legacy_team_chat_archived,
      summary.exceptions.length,
      JSON.stringify(summary),
    ]
  );

  return summary;
}

async function backfillAllFirms(options = {}) {
  const { rows } = await pool.query('SELECT id FROM firms ORDER BY id ASC');
  const results = [];
  for (const firm of rows) {
    results.push(await backfillFirm(firm.id, options));
  }
  return results;
}

module.exports = { backfillFirm, backfillAllFirms };
