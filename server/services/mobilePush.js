'use strict';

const { pool } = require('../db');
const { captureNotification } = require('./runtimeSafety');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Keep tokens from separate Expo app projects out of the same request.
const MAX_EXPO_BATCH = 1;

function compactText(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 178 ? text.slice(0, 175).trimEnd() + '...' : text;
}

function preferenceColumnForType(type) {
  if (type === 'message') return 'messages_enabled';
  if (type === 'document') return 'documents_enabled';
  if (type === 'tax_delivery') return 'tax_delivery_enabled';
  if (type === 'task') return 'tasks_enabled';
  return 'messages_enabled';
}

function staffPreferenceColumnForType(type) {
  if (type === 'team_chat') return 'team_chat_enabled';
  if (type === 'task') return 'tasks_enabled';
  return 'client_messages_enabled';
}

async function getClientBadgeCount({ firmId, personId }) {
  const companyIdsRes = await pool.query(
    `SELECT pca.company_id
     FROM person_company_access pca
     JOIN people p ON p.id = pca.person_id
     JOIN companies c ON c.id = pca.company_id
     WHERE pca.person_id = $1 AND p.firm_id = $2 AND c.firm_id = $2`,
    [personId, firmId]
  );
  const companyIds = companyIdsRes.rows.map(r => r.company_id);

  const messageCountPromise = pool.query(
    `SELECT COUNT(*)::int AS count
     FROM message_threads mt
     JOIN messages m ON m.thread_id = mt.id
     WHERE mt.person_id = $1 AND mt.firm_id = $2
       AND m.sender_type IN ('staff', 'agent')
       AND m.is_internal = false
       AND m.read_at IS NULL`,
    [personId, firmId]
  );

  const documentCountPromise = companyIds.length
    ? pool.query(
        `SELECT COUNT(*)::int AS count
         FROM documents
         WHERE firm_id = $1 AND folder_section NOT IN ('private', 'client_uploaded') AND viewed_at IS NULL AND COALESCE(delivered_at, created_at) > NOW() - INTERVAL '30 days'
           AND ((owner_type = 'person' AND owner_id = $2) OR (owner_type = 'company' AND owner_id = ANY($3)))`,
        [firmId, personId, companyIds]
      )
    : pool.query(
        `SELECT COUNT(*)::int AS count
         FROM documents
         WHERE firm_id = $1 AND folder_section NOT IN ('private', 'client_uploaded') AND viewed_at IS NULL AND COALESCE(delivered_at, created_at) > NOW() - INTERVAL '30 days'
           AND owner_type = 'person' AND owner_id = $2`,
        [firmId, personId]
      );

  const taxDeliveryPromise = pool.query(
    `SELECT COUNT(*)::int AS count
     FROM tax_deliveries td
     JOIN tax_delivery_signers tds ON tds.delivery_id = td.id
     WHERE td.firm_id = $1 AND tds.person_id = $2
       AND td.status IN ('sent', 'approved', 'needs_changes')
       AND tds.needs_changes_at IS NULL
       AND (tds.approved_at IS NULL OR (tds.approved_at IS NOT NULL AND tds.signed_at IS NULL))`,
    [firmId, personId]
  );

  const [messages, documents, deliveries] = await Promise.all([
    messageCountPromise,
    documentCountPromise,
    taxDeliveryPromise,
  ]);

  return (messages.rows[0]?.count || 0) + (documents.rows[0]?.count || 0) + (deliveries.rows[0]?.count || 0);
}

async function getStaffBadgeCount({ firmId, staffUserId }) {
  const clientMessagePromise = pool.query(
    `WITH my_threads AS (
       SELECT mt.id
       FROM message_threads mt
       LEFT JOIN thread_participants tp
         ON tp.thread_id = mt.id AND tp.firm_user_id = $2 AND tp.archived_at IS NULL
       WHERE mt.firm_id = $1
         AND mt.status != 'archived'
         AND (mt.staff_user_id != $2 OR mt.staff_archived_at IS NULL)
         AND (mt.staff_user_id = $2 OR tp.id IS NOT NULL)
     )
     SELECT COUNT(*)::int AS count
     FROM messages m
     JOIN my_threads t ON t.id = m.thread_id
     WHERE m.sender_type = 'client'
       AND m.is_internal = false
       AND m.read_at IS NULL`,
    [firmId, staffUserId]
  );

  const teamChatPromise = pool.query(
    `WITH visible_conversations AS (
       SELECT c.id
       FROM native_team_chat_conversations c
       JOIN native_team_chat_members mine
         ON mine.conversation_id = c.id
        AND mine.firm_id = c.firm_id
        AND mine.staff_user_id = $2
        AND mine.left_at IS NULL
       LEFT JOIN native_team_chat_user_state us
         ON us.conversation_id = c.id
        AND us.firm_id = c.firm_id
        AND us.staff_user_id = $2
       WHERE c.firm_id = $1
         AND COALESCE(us.is_archived,FALSE) = FALSE
         AND COALESCE(us.is_hidden,FALSE) = FALSE
     )
     SELECT COUNT(*)::int AS count
     FROM native_team_chat_messages msg
     JOIN visible_conversations vc ON vc.id = msg.conversation_id
     LEFT JOIN native_team_chat_read_state rs
       ON rs.conversation_id = msg.conversation_id
      AND rs.firm_id = msg.firm_id
      AND rs.staff_user_id = $2
     WHERE msg.firm_id = $1
       AND msg.deleted_at IS NULL
       AND msg.sender_staff_user_id IS DISTINCT FROM $2
       AND (rs.last_read_message_id IS NULL OR msg.id > rs.last_read_message_id)`,
    [firmId, staffUserId]
  );

  const transferPromise = pool.query(
    `SELECT COUNT(DISTINCT f.thread_id)::int AS count
     FROM message_thread_forwards f
     JOIN message_threads mt ON mt.id = f.thread_id AND mt.firm_id = f.firm_id
     WHERE f.firm_id = $1 AND f.forwarded_to_id = $2 AND f.seen_at IS NULL
       AND mt.staff_user_id = $2 AND mt.status != 'archived' AND mt.staff_archived_at IS NULL`,
    [firmId, staffUserId]
  ).catch(() => ({ rows: [{ count: 0 }] }));

  const [clientMessages, teamChat, transfers] = await Promise.all([clientMessagePromise, teamChatPromise, transferPromise]);
  return (clientMessages.rows[0]?.count || 0) + (teamChat.rows[0]?.count || 0) + (transfers.rows[0]?.count || 0);
}

async function activeDevicesForPerson({ firmId, personId, type }) {
  const preferenceColumn = preferenceColumnForType(type);
  const { rows } = await pool.query(
    `SELECT d.id, d.push_token
     FROM portal_mobile_devices d
     JOIN people person ON person.id=d.person_id AND person.firm_id=d.firm_id
     LEFT JOIN portal_mobile_notification_preferences p
       ON p.firm_id = d.firm_id AND p.person_id = d.person_id
     WHERE d.firm_id = $1
       AND d.person_id = $2
       AND (CASE WHEN d.signer_role='spouse' THEN person.spouse_portal_enabled ELSE person.portal_enabled END)
       AND (d.session_id IS NULL OR EXISTS(SELECT 1 FROM account_sessions s WHERE s.id=d.session_id AND s.firm_id=d.firm_id AND s.kind='portal' AND s.account_id=d.person_id AND s.signer_role=d.signer_role AND s.revoked_at IS NULL AND s.expires_at>NOW()))
       AND d.disabled_at IS NULL
       AND COALESCE(p.${preferenceColumn}, TRUE) = TRUE
       AND (d.push_token LIKE 'ExpoPushToken[%' OR d.push_token LIKE 'ExponentPushToken[%')
     ORDER BY d.last_seen_at DESC NULLS LAST`,
    [firmId, personId]
  );
  return rows;
}

async function activeDevicesForStaff({ firmId, staffUserId, type }) {
  const preferenceColumn = staffPreferenceColumnForType(type);
  const { rows } = await pool.query(
    `SELECT d.id, d.push_token
     FROM staff_mobile_devices d
     JOIN firm_users fu
       ON fu.id = d.staff_user_id
      AND fu.firm_id = d.firm_id
      AND fu.accepted_at IS NOT NULL
      AND fu.archived_at IS NULL
     LEFT JOIN staff_mobile_notification_preferences p
       ON p.firm_id = d.firm_id AND p.staff_user_id = d.staff_user_id
     WHERE d.firm_id = $1
       AND d.staff_user_id = $2
       AND (d.session_id IS NULL OR EXISTS(SELECT 1 FROM account_sessions s WHERE s.id=d.session_id AND s.firm_id=d.firm_id AND s.kind='staff' AND s.account_id=d.staff_user_id AND s.revoked_at IS NULL AND s.expires_at>NOW()))
       AND d.disabled_at IS NULL
       AND COALESCE(p.${preferenceColumn}, TRUE) = TRUE
       AND (d.push_token LIKE 'ExpoPushToken[%' OR d.push_token LIKE 'ExponentPushToken[%')
     ORDER BY d.last_seen_at DESC NULLS LAST`,
    [firmId, staffUserId]
  );
  return rows;
}

async function sendExpoBatch(messages) {
  const captured = await captureNotification('push', { messages });
  if (captured) return captured;
  for (let i = 0; i < messages.length; i += MAX_EXPO_BATCH) {
    const chunk = messages.slice(i, i + MAX_EXPO_BATCH);
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chunk),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.errors?.[0]?.message || `Expo push failed (${response.status})`);
    }

    const tickets = Array.isArray(body?.data) ? body.data : [];
    await Promise.all(tickets.map(async (ticket, index) => {
      const detailsError = ticket?.details?.error;
      if (ticket?.status === 'error' && detailsError === 'DeviceNotRegistered') {
        const token = chunk[index]?.to;
        if (token) {
          await pool.query(
            `UPDATE portal_mobile_devices SET disabled_at = NOW(), updated_at = NOW() WHERE push_token = $1`,
            [token]
          );
          await pool.query('UPDATE staff_mobile_devices SET disabled_at=NOW() WHERE push_token=$1',[token]);
        }
      }
    }));
  }
}

async function sendClientMobilePush({ firmId, personId, type = 'message', title, body, data = {} }) {
  try {
    const [devices, badge] = await Promise.all([
      activeDevicesForPerson({ firmId, personId, type }),
      getClientBadgeCount({ firmId, personId }),
    ]);

    if (!devices.length) return { sent: 0 };

    const messages = devices.map(device => ({
      to: device.push_token,
      title: compactText(title, 'Client Portal'),
      body: compactText(body, 'You have a new item waiting in your portal.'),
      sound: 'default',
      badge,
      data: {
        type,
        firmId,
        personId,
        ...data,
      },
    }));

    const delivery = await sendExpoBatch(messages);
    return delivery?.captured ? { sent: 0, captured: messages.length } : { sent: messages.length };
  } catch (err) {
    console.error('[mobile-push] send failed (non-fatal):', err.message);
    return { sent: 0, error: err.message };
  }
}

async function sendStaffMobilePush({ firmId, staffUserId, type = 'client_message', title, body, data = {} }) {
  try {
    const [devices, badge] = await Promise.all([
      activeDevicesForStaff({ firmId, staffUserId, type }),
      getStaffBadgeCount({ firmId, staffUserId }),
    ]);

    if (!devices.length) return { sent: 0 };

    const messages = devices.map(device => ({
      to: device.push_token,
      title: compactText(title, 'DarkLion Staff'),
      body: compactText(body, 'You have a new staff item waiting in DarkLion.'),
      sound: 'default',
      badge,
      data: {
        type,
        firmId,
        staffUserId,
        ...data,
      },
    }));

    const delivery = await sendExpoBatch(messages);
    return delivery?.captured ? { sent: 0, captured: messages.length } : { sent: messages.length };
  } catch (err) {
    console.error('[mobile-push] staff send failed (non-fatal):', err.message);
    return { sent: 0, error: err.message };
  }
}

async function sendDocumentDeliveredMobilePush({ firmId, document }) {
  if (!document?.id) return { sent: 0 };

  let personIds = [];
  if (document.owner_type === 'person') {
    personIds = [document.owner_id];
  } else if (document.owner_type === 'company') {
    const { rows } = await pool.query(
      `SELECT pca.person_id
       FROM person_company_access pca
       JOIN people p ON p.id = pca.person_id AND p.firm_id = $1
       WHERE pca.company_id = $2`,
      [firmId, document.owner_id]
    );
    personIds = rows.map(r => r.person_id);
  }

  const uniquePersonIds = [...new Set(personIds.filter(Boolean))];
  const results = await Promise.all(uniquePersonIds.map(personId => (
    sendClientMobilePush({
      firmId,
      personId,
      type: 'document',
      title: 'New document',
      body: `${compactText(document.display_name, 'A document')} is ready in your portal.`,
      data: { documentId: document.id },
    })
  )));

  return { sent: results.reduce((total, result) => total + (result.sent || 0), 0) };
}

module.exports = { getClientBadgeCount, getStaffBadgeCount, sendClientMobilePush, sendStaffMobilePush, sendDocumentDeliveredMobilePush };
