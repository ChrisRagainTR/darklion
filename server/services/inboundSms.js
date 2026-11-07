const { archiveClientMessageCreatedFailClosed } = require('./communicationArchive');
'use strict';

const { sendStaffMobilePush } = require('./mobilePush');

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function phoneMatchKey(value) {
  return normalizePhone(value).replace(/\D/g, '').slice(-10);
}

function normalizeOptOutType(value, body) {
  const explicit = String(value || '').trim().toUpperCase();
  if (explicit) return explicit;
  const keyword = String(body || '').trim().toUpperCase();
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) return 'STOP';
  if (['START', 'UNSTOP'].includes(keyword)) return 'START';
  if (keyword === 'HELP' || keyword === 'INFO') return 'HELP';
  return '';
}

async function resolveFirm(client, toPhone, fromPhone) {
  const destination = phoneMatchKey(toPhone);
  if (!destination) return null;

  const routeClientPhone = normalizePhone(fromPhone);
  const routeTwilioPhone = normalizePhone(toPhone);
  if (routeClientPhone && routeTwilioPhone) {
    const { rows: routed } = await client.query(
      `SELECT DISTINCT firm_id AS id
         FROM sms_thread_routes
        WHERE client_phone = $1 AND twilio_phone = $2
        ORDER BY firm_id
        LIMIT 2`,
      [routeClientPhone, routeTwilioPhone]
    );
    if (routed.length === 1) return routed[0];
  }

  const { rows: configured } = await client.query(
    `SELECT id
       FROM firms
      WHERE RIGHT(REGEXP_REPLACE(COALESCE(twilio_phone_number, ''), '\\D', '', 'g'), 10) = $1
      ORDER BY id
      LIMIT 2`,
    [destination]
  );
  if (configured.length === 1) return configured[0];
  if (configured.length > 1) return null;

  const environmentNumber = phoneMatchKey(process.env.TWILIO_FROM_NUMBER);
  if (!environmentNumber || environmentNumber !== destination) return null;

  const environmentFirmId = Number.parseInt(process.env.TWILIO_FIRM_ID || '', 10);
  if (environmentFirmId) {
    const { rows } = await client.query('SELECT id FROM firms WHERE id = $1', [environmentFirmId]);
    return rows[0] || null;
  }

  // Backward-compatible single-firm fallback. Multi-tenant deployments should
  // set firms.twilio_phone_number (or TWILIO_FIRM_ID) explicitly.
  const { rows } = await client.query('SELECT id FROM firms ORDER BY id LIMIT 2');
  return rows.length === 1 ? rows[0] : null;
}

async function findPerson(client, firmId, fromPhone) {
  const matchKey = phoneMatchKey(fromPhone);
  if (!matchKey) return { status: 'unmatched', person: null };

  const { rows } = await client.query(
    `SELECT id, first_name, last_name, sms_opted_out
       FROM people
      WHERE firm_id = $1
        AND COALESCE(phone, '') <> ''
        AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2
      ORDER BY id
      LIMIT 2`,
    [firmId, matchKey]
  );
  if (rows.length === 1) return { status: 'matched', person: rows[0] };
  return { status: rows.length > 1 ? 'ambiguous' : 'unmatched', person: null };
}

async function findActiveRoute(client, firmId, fromPhone, toPhone) {
  const { rows } = await client.query(
    `SELECT str.thread_id, str.person_id, mt.staff_user_id,
            p.first_name, p.last_name, COALESCE(p.sms_opted_out, false) AS sms_opted_out
       FROM sms_thread_routes str
       JOIN message_threads mt
         ON mt.id = str.thread_id AND mt.firm_id = str.firm_id AND mt.person_id = str.person_id
       JOIN people p
         ON p.id = str.person_id AND p.firm_id = str.firm_id
      WHERE str.firm_id = $1 AND str.client_phone = $2 AND str.twilio_phone = $3
      LIMIT 1`,
    [firmId, normalizePhone(fromPhone), normalizePhone(toPhone)]
  );
  return rows[0] || null;
}

async function saveActiveRoute(client, { firmId, personId, threadId, clientPhone, twilioPhone, direction }) {
  const inbound = direction === 'inbound';
  await client.query(
    `INSERT INTO sms_thread_routes
       (firm_id, person_id, thread_id, client_phone, twilio_phone,
        last_outbound_at, last_inbound_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $6 THEN NULL ELSE NOW() END,
             CASE WHEN $6 THEN NOW() ELSE NULL END,
             NOW(), NOW())
     ON CONFLICT (firm_id, client_phone, twilio_phone)
     DO UPDATE SET
       person_id = EXCLUDED.person_id,
       thread_id = EXCLUDED.thread_id,
       last_outbound_at = CASE WHEN $6 THEN sms_thread_routes.last_outbound_at ELSE NOW() END,
       last_inbound_at = CASE WHEN $6 THEN NOW() ELSE sms_thread_routes.last_inbound_at END,
       updated_at = NOW()`,
    [firmId, personId, threadId, normalizePhone(clientPhone), normalizePhone(twilioPhone), inbound]
  );
}

async function findOrCreateThread(client, firmId, person) {
  const { rows: threads } = await client.query(
    `SELECT mt.id, mt.staff_user_id
      FROM message_threads mt
      WHERE mt.firm_id = $1 AND mt.person_id = $2
        AND mt.staff_user_id IS NOT NULL
        AND mt.category IS DISTINCT FROM 'internal'
      ORDER BY
        EXISTS (
          SELECT 1
            FROM messages m
           WHERE m.thread_id = mt.id
             AND (m.channel = 'sms' OR m.body LIKE '📱 SMS sent:%' OR m.body LIKE '📱 SMS received:%')
        ) DESC,
        (mt.status = 'open') DESC,
        mt.last_message_at DESC NULLS LAST
      LIMIT 1`,
    [firmId, person.id]
  );
  if (threads[0]) return { ...threads[0], isNew: false };

  const { rows: staff } = await client.query(
    `SELECT id
       FROM firm_users
      WHERE firm_id = $1
        AND accepted_at IS NOT NULL
        AND archived_at IS NULL
      ORDER BY
        CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        id
      LIMIT 1`,
    [firmId]
  );
  const staffUserId = staff[0]?.id || null;
  const displayName = `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'client';
  const { rows: created } = await client.query(
    `INSERT INTO message_threads
       (firm_id, person_id, staff_user_id, subject, status, category, last_message_at)
     VALUES ($1, $2, $3, $4, 'open', 'general', NOW())
     RETURNING id, staff_user_id`,
    [firmId, person.id, staffUserId, `Messages with ${displayName}`]
  );
  return { ...created[0], isNew: true };
}

async function processInboundSms({ pool, payload }) {
  const providerMessageId = String(payload.MessageSid || '').trim();
  const fromPhone = normalizePhone(payload.From);
  const toPhone = normalizePhone(payload.To);
  const body = String(payload.Body || '').trim();
  const optOutType = normalizeOptOutType(payload.OptOutType, body);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const firm = await resolveFirm(client, toPhone, fromPhone);
    const eventInsert = await client.query(
      `INSERT INTO twilio_inbound_sms_events
         (provider_message_id, firm_id, from_phone, to_phone, body, opt_out_type, match_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider_message_id) DO NOTHING
       RETURNING id`,
      [providerMessageId, firm?.id || null, fromPhone, toPhone, body, optOutType,
       firm ? 'received' : 'unknown_destination']
    );

    if (!eventInsert.rows[0]) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }

    if (!firm) {
      await client.query('COMMIT');
      return { accepted: true, matchStatus: 'unknown_destination' };
    }

    const activeRoute = await findActiveRoute(client, firm.id, fromPhone, toPhone);
    const match = activeRoute
      ? {
          status: 'matched',
          person: {
            id: activeRoute.person_id,
            first_name: activeRoute.first_name,
            last_name: activeRoute.last_name,
            sms_opted_out: activeRoute.sms_opted_out,
          },
        }
      : await findPerson(client, firm.id, fromPhone);
    if (!match.person) {
      await client.query(
        'UPDATE twilio_inbound_sms_events SET match_status = $1 WHERE id = $2',
        [match.status, eventInsert.rows[0].id]
      );
      await client.query('COMMIT');
      return { accepted: true, firmId: firm.id, matchStatus: match.status };
    }

    if (optOutType === 'STOP' || optOutType === 'START') {
      await client.query(
        `UPDATE people
            SET sms_opted_out = $1, sms_opt_status_updated_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND firm_id = $3`,
        [optOutType === 'STOP', match.person.id, firm.id]
      );
    }

    const thread = activeRoute
      ? { id: activeRoute.thread_id, staff_user_id: activeRoute.staff_user_id, isNew: false }
      : await findOrCreateThread(client, firm.id, match.person);
    const storedBody = body || (optOutType ? `[${optOutType}]` : '[Empty SMS]');
    const { rows: messages } = await client.query(
      `INSERT INTO messages
         (thread_id, sender_type, sender_id, body, channel, provider_message_id,
          provider_status, provider_from_phone, provider_to_phone, created_at)
       VALUES ($1, 'client', $2, $3, 'sms', $4, 'received', $5, $6, NOW())
       RETURNING id`,
      [thread.id, match.person.id, storedBody,
       providerMessageId, fromPhone, toPhone]
    );
    const messageId = messages[0].id;

    await client.query(
      `UPDATE message_threads
          SET status = 'open', staff_archived_at = NULL, last_message_at = NOW()
        WHERE id = $1`,
      [thread.id]
    );
    await client.query(
      `UPDATE twilio_inbound_sms_events
          SET person_id = $1, message_id = $2, match_status = 'matched'
        WHERE id = $3`,
      [match.person.id, messageId, eventInsert.rows[0].id]
    );
    await saveActiveRoute(client, {
      firmId: firm.id,
      personId: match.person.id,
      threadId: thread.id,
      clientPhone: fromPhone,
      twilioPhone: toPhone,
      direction: 'inbound',
    });
    await client.query('COMMIT');

    await archiveClientMessageCreatedFailClosed({ firmId: firm.id, messageId });

    return {
      accepted: true,
      matchStatus: 'matched',
      firmId: firm.id,
      personId: match.person.id,
      threadId: thread.id,
      staffUserId: thread.staff_user_id,
      messageId,
      body,
      optOutType,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* original error wins */ }
    throw error;
  } finally {
    client.release();
  }
}

function dispatchInboundSmsNotifications({ app, result }) {
  const pusher = app.get('pusher');
  if (result.matchStatus !== 'matched') {
    if (pusher && result.firmId && ['unmatched', 'ambiguous'].includes(result.matchStatus)) {
      Promise.resolve(pusher.trigger(
        `private-firm-${result.firmId}`,
        'sms-exception',
        { matchStatus: result.matchStatus }
      )).catch(error => console.error('[twilio-inbound] exception alert non-fatal:', error.message));
    }
    return;
  }

  if (pusher) {
    Promise.resolve(pusher.trigger(
      `private-firm-${result.firmId}`,
      'message-new',
      { threadId: result.threadId, senderType: 'client' }
    )).catch(error => console.error('[twilio-inbound] pusher non-fatal:', error.message));
  }

  if (result.staffUserId) {
    setImmediate(() => {
      sendStaffMobilePush({
        firmId: result.firmId,
        staffUserId: result.staffUserId,
        type: 'client_message',
        title: 'New client text message',
        body: result.body || 'A client sent a text message.',
        data: {
          threadId: result.threadId,
          messageId: result.messageId,
          personId: result.personId,
          channel: 'sms',
        },
      }).catch(error => console.error('[twilio-inbound] mobile push non-fatal:', error.message));
    });
  }

  // Carrier opt-out/help commands should be visible to staff, but should not
  // produce an AI reply draft.
  if (result.body && !result.optOutType) {
    setImmediate(() => {
      const { enqueueEmmaDraftJob } = require('./emmaDraftJobs');
      enqueueEmmaDraftJob({
        firmId: result.firmId,
        threadId: result.threadId,
        sourceMessageId: result.messageId,
        staffUserId: result.staffUserId,
        personId: result.personId,
        sourceEvent: 'inbox.message.received',
        priority: 3,
      }).catch(error => console.error('[twilio-inbound] Emma draft non-fatal:', error.message));
    });
  }
}

module.exports = {
  dispatchInboundSmsNotifications,
  normalizeOptOutType,
  normalizePhone,
  phoneMatchKey,
  processInboundSms,
  saveActiveRoute,
};
