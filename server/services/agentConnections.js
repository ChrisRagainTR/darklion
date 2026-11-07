'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { pool } = require('../db');
const { decrypt } = require('../utils/encryption');

const DEFAULT_TIMEOUT_MS = 12000;
const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

function buildChatMessageId() {
  return `chat_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hasCapability(connection, capability) {
  const caps = connection?.capabilities || {};
  return caps[capability] !== false;
}

function isBlockedIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.includes('.')) return isBlockedIpv4(normalized.slice(normalized.lastIndexOf(':') + 1));

  const first = parseInt(normalized.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00    // multicast ff00::/8
  );
}

function isBlockedIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

async function validateAgentEndpointUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    const err = new Error('Invalid endpoint_url');
    err.statusCode = 400;
    throw err;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const err = new Error('endpoint_url must use http or https');
    err.statusCode = 400;
    throw err;
  }

  if (parsed.username || parsed.password) {
    const err = new Error('endpoint_url must not include credentials');
    err.statusCode = 400;
    throw err;
  }

  let hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (!hostname || LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    const err = new Error('endpoint_url must not target localhost');
    err.statusCode = 400;
    throw err;
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      const err = new Error('endpoint_url must not target private or local addresses');
      err.statusCode = 400;
      throw err;
    }
    return parsed.href;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    const err = new Error('endpoint_url hostname could not be resolved safely');
    err.statusCode = 400;
    throw err;
  }

  if (!addresses.length || addresses.some(entry => isBlockedIp(entry.address))) {
    const err = new Error('endpoint_url must not resolve to private or local addresses');
    err.statusCode = 400;
    throw err;
  }

  return parsed.href;
}

async function auditAgentEvent({ firmId, staffUserId, agentConnectionId, eventType, relatedThreadId = null, metadata = {} }) {
  try {
    await pool.query(
      `INSERT INTO agent_audit_events (firm_id, staff_user_id, agent_connection_id, event_type, related_thread_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [firmId, staffUserId || null, agentConnectionId || null, eventType, relatedThreadId, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    console.error('[agent-connections] audit error (non-fatal):', err.message);
  }
}

async function getActiveAgentConnection(firmId, staffUserId, capability = 'inbox_drafts') {
  if (!firmId || !staffUserId) return null;
  const { rows } = await pool.query(
    `SELECT * FROM agent_connections
     WHERE firm_id = $1 AND staff_user_id = $2 AND status = 'connected'
     LIMIT 1`,
    [firmId, staffUserId]
  );
  const connection = rows[0] || null;
  if (!connection || !hasCapability(connection, capability)) return null;
  return connection;
}

async function loadInboxWakeContext({ firmId, threadId, personId, staffUserId, clientMessage }) {
  const { rows: personRows } = await pool.query(
    `SELECT p.id, p.first_name, p.last_name, p.email, p.phone, p.notes,
            r.name AS relationship_name,
            fu.name AS staff_name, fu.display_name AS staff_display_name, fu.email AS staff_email
     FROM people p
     LEFT JOIN relationships r ON r.id = p.relationship_id
     LEFT JOIN firm_users fu ON fu.id = $3 AND fu.firm_id = p.firm_id
     WHERE p.id = $1 AND p.firm_id = $2`,
    [personId, firmId, staffUserId]
  );
  const person = personRows[0] || {};
  const clientName = [person.first_name, person.last_name].filter(Boolean).join(' ').trim() || 'Client';

  const { rows: historyRows } = await pool.query(
    `SELECT m.id, m.sender_type, m.body, m.created_at,
            CASE WHEN m.sender_type = 'staff' THEN COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email)
                 WHEN m.sender_type = 'agent' THEN 'Agent'
                 ELSE $3 END AS sender_name
     FROM messages m
     LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
     WHERE m.thread_id = $1 AND m.is_internal = false AND m.removed_at IS NULL
     ORDER BY m.created_at DESC
     LIMIT 20`,
    [threadId, firmId, clientName]
  );

  return {
    client_name: clientName,
    client_person_id: personId,
    client_email: person.email || null,
    relationship_name: person.relationship_name || null,
    client_notes: person.notes || null,
    assigned_staff: person.staff_display_name || person.staff_name || person.staff_email || null,
    latest_client_message: clientMessage,
    thread_history: historyRows.reverse().map(m => ({
      id: m.id,
      sender_type: m.sender_type,
      sender_name: m.sender_name,
      body: m.body,
      created_at: m.created_at,
    })),
  };
}

function buildHeaders(connection) {
  const headers = { 'Content-Type': 'application/json' };
  const secret = connection.auth_secret_encrypted ? decrypt(connection.auth_secret_encrypted) : null;

  if (secret && connection.auth_type === 'bearer') {
    headers.Authorization = `Bearer ${secret}`;
  } else if (secret && connection.auth_type === 'api_key') {
    headers['X-API-Key'] = secret;
  }

  return headers;
}

async function postAgentWake(connection, payload) {
  const endpointUrl = await validateAgentEndpointUrl(connection.endpoint_url);
  if (!endpointUrl) throw new Error('Agent connection has no endpoint URL');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: buildHeaders(connection),
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    });

    let body = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); }
      catch (_) { body = { text }; }
    }

    if (!res.ok) {
      throw new Error(body?.error || body?.message || `Agent wake failed with HTTP ${res.status}`);
    }

    return body || { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function storeMessageDraft({ firmId, threadId, staffUserId, agentConnectionId, draftBody, confidence = null, agentNotes = null, sourceEvent = 'inbox.message.received' }) {
  if (!draftBody || !draftBody.trim()) return null;

  const { rows } = await pool.query(
    `INSERT INTO message_drafts (firm_id, thread_id, staff_user_id, agent_connection_id, draft_body, confidence, agent_notes, source_event)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [firmId, threadId, staffUserId || null, agentConnectionId || null, draftBody.trim(), confidence, agentNotes, sourceEvent]
  );
  return rows[0];
}

async function sendChatToConnectedAgent({ firmId, staffUserId, message, history = [], appUrl }) {
  const connection = await getActiveAgentConnection(firmId, staffUserId, 'chat');
  if (!connection) return { skipped: true, reason: 'no_connected_agent' };

  const baseUrl = (appUrl || process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');
  const chatMessageId = buildChatMessageId();
  const { rows: staffRows } = await pool.query(
    `SELECT id, name, display_name, email FROM firm_users WHERE firm_id = $1 AND id = $2 LIMIT 1`,
    [firmId, staffUserId]
  );
  const staff = staffRows[0] || {};

  const payload = {
    event: 'chat.message.received',
    firm_id: firmId,
    staff_user_id: staffUserId,
    chat_message_id: chatMessageId,
    session_key: connection.session_key || null,
    callback_url: `${baseUrl}/api/agent-callbacks/chat-reply`,
    instructions: 'Reply to the staff chat message. You may either return JSON with reply/message/text/content immediately, or post the reply later to callback_url with chat_message_id and reply. Do not send external client communications unless explicitly asked and supported by your own tools.',
    message,
    context: {
      app_url: baseUrl,
      staff_user: {
        id: staff.id || staffUserId,
        name: staff.display_name || staff.name || staff.email || null,
        email: staff.email || null,
      },
      chat_history: (history || []).slice(-20).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content || '',
        timestamp: m.timestamp || null,
        from: m.from || null,
      })),
    },
  };

  await auditAgentEvent({
    firmId,
    staffUserId,
    agentConnectionId: connection.id,
    eventType: 'chat_wake_sent',
    metadata: { provider: connection.provider, endpoint_url: connection.endpoint_url, chat_message_id: chatMessageId },
  });

  try {
    const result = await postAgentWake(connection, payload);
    await pool.query(
      `UPDATE agent_connections SET last_wake_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [connection.id]
    );

    const reply = result?.reply || result?.message || result?.text || result?.content || result?.response;
    if (!reply || !String(reply).trim()) {
      await auditAgentEvent({
        firmId,
        staffUserId,
        agentConnectionId: connection.id,
        eventType: 'chat_wake_delivered_no_inline_reply',
        metadata: { response_keys: Object.keys(result || {}) },
      });
      return {
        ok: true,
        delivered: true,
        awaitingAsyncReply: true,
        connection,
        chatMessageId,
        reply: `Sent to ${connection.agent_name || 'your connected agent'}. Check Telegram for the response.`,
        raw: result,
      };
    }

    await auditAgentEvent({
      firmId,
      staffUserId,
      agentConnectionId: connection.id,
      eventType: 'chat_reply_received_inline',
      metadata: { response_keys: Object.keys(result || {}) },
    });

    return { ok: true, delivered: true, connection, chatMessageId, reply: String(reply).trim(), raw: result };
  } catch (err) {
    await pool.query(
      `UPDATE agent_connections SET last_error = $2, updated_at = NOW() WHERE id = $1`,
      [connection.id, err.message]
    );
    await auditAgentEvent({
      firmId,
      staffUserId,
      agentConnectionId: connection.id,
      eventType: 'chat_wake_error',
      metadata: { error: err.message },
    });
    throw err;
  }
}

async function wakeAgentForInboxMessage({ firmId, threadId, personId, staffUserId, clientMessage, appUrl }) {
  const connection = await getActiveAgentConnection(firmId, staffUserId, 'inbox_drafts');
  if (!connection) return { skipped: true, reason: 'no_connected_agent' };

  const context = await loadInboxWakeContext({ firmId, threadId, personId, staffUserId, clientMessage });
  const baseUrl = (appUrl || process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

  const payload = {
    event: 'inbox.message.received',
    firm_id: firmId,
    staff_user_id: staffUserId,
    thread_id: threadId,
    client_person_id: personId,
    instructions: 'Draft a client reply only. Do not send. Return JSON with draft_body, confidence, and optional notes, or POST the same fields to callback_url.',
    context,
    callback_url: `${baseUrl}/api/agent-callbacks/inbox-draft`,
  };

  await auditAgentEvent({
    firmId,
    staffUserId,
    agentConnectionId: connection.id,
    eventType: 'inbox_wake_sent',
    relatedThreadId: threadId,
    metadata: { provider: connection.provider, endpoint_url: connection.endpoint_url },
  });

  try {
    const result = await postAgentWake(connection, payload);
    await pool.query(
      `UPDATE agent_connections SET last_wake_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [connection.id]
    );

    const draftBody = result?.draft_body || result?.draftBody || result?.draft;
    let draft = null;
    if (draftBody) {
      draft = await storeMessageDraft({
        firmId,
        threadId,
        staffUserId,
        agentConnectionId: connection.id,
        draftBody,
        confidence: result?.confidence ?? null,
        agentNotes: result?.notes || result?.agent_notes || null,
      });
      await auditAgentEvent({
        firmId,
        staffUserId,
        agentConnectionId: connection.id,
        eventType: 'inbox_draft_received_inline',
        relatedThreadId: threadId,
        metadata: { draft_id: draft.id },
      });
    }

    return { ok: true, draft };
  } catch (err) {
    await pool.query(
      `UPDATE agent_connections SET status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [connection.id, err.message]
    );
    await auditAgentEvent({
      firmId,
      staffUserId,
      agentConnectionId: connection.id,
      eventType: 'inbox_wake_error',
      relatedThreadId: threadId,
      metadata: { error: err.message },
    });
    throw err;
  }
}

module.exports = {
  auditAgentEvent,
  buildChatMessageId,
  getActiveAgentConnection,
  hashToken,
  sendChatToConnectedAgent,
  storeMessageDraft,
  validateAgentEndpointUrl,
  wakeAgentForInboxMessage,
};
