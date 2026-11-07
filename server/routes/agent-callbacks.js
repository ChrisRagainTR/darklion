'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { auditAgentEvent, hashToken, storeMessageDraft } = require('../services/agentConnections');

const router = Router();

async function getConnectionFromCallbackToken(req, res) {
  const token = req.headers['x-darklion-agent-token'] || req.headers['x-agent-token'];
  if (!token) {
    res.status(401).json({ error: 'Missing agent callback token' });
    return null;
  }

  const { rows: connRows } = await pool.query(
    `SELECT * FROM agent_connections WHERE callback_token_hash = $1 LIMIT 1`,
    [hashToken(token)]
  );
  const connection = connRows[0];
  if (!connection) {
    res.status(401).json({ error: 'Invalid agent callback token' });
    return null;
  }
  if (connection.status !== 'connected') {
    res.status(403).json({ error: 'Agent connection is not connected' });
    return null;
  }

  return connection;
}

// POST /api/agent-callbacks/inbox-draft — connected agent posts a draft back
router.post('/inbox-draft', async (req, res) => {
  const { thread_id, draft_body, confidence, notes, agent_notes } = req.body || {};
  const threadId = parseInt(thread_id, 10);
  if (!Number.isInteger(threadId) || !draft_body || !String(draft_body).trim()) {
    return res.status(400).json({ error: 'thread_id and draft_body are required' });
  }

  try {
    const connection = await getConnectionFromCallbackToken(req, res);
    if (!connection) return;

    const { rows: threadRows } = await pool.query(
      `SELECT id, firm_id, staff_user_id
       FROM message_threads
       WHERE id = $1 AND firm_id = $2 AND staff_user_id = $3`,
      [threadId, connection.firm_id, connection.staff_user_id]
    );
    const thread = threadRows[0];
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const draft = await storeMessageDraft({
      firmId: connection.firm_id,
      threadId: thread.id,
      staffUserId: thread.staff_user_id || connection.staff_user_id,
      agentConnectionId: connection.id,
      draftBody: draft_body,
      confidence: confidence ?? null,
      agentNotes: notes || agent_notes || null,
    });

    await auditAgentEvent({
      firmId: connection.firm_id,
      staffUserId: thread.staff_user_id || connection.staff_user_id,
      agentConnectionId: connection.id,
      eventType: 'inbox_draft_received_callback',
      relatedThreadId: thread.id,
      metadata: { draft_id: draft.id },
    });

    const pusher = req.app.get('pusher');
    if (pusher) {
      pusher.trigger(`private-firm-${connection.firm_id}`, 'agent-draft-new', {
        threadId: thread.id,
        draftId: draft.id,
        staffUserId: draft.staff_user_id,
      }).catch(err => console.error('[agent-callbacks] pusher draft notify error:', err.message));
    }

    res.status(201).json({ ok: true, draft_id: draft.id });
  } catch (err) {
    console.error('[agent-callbacks] inbox-draft error:', err);
    res.status(500).json({ error: 'Failed to store draft' });
  }
});

// POST /api/agent-callbacks/chat-reply — connected agent posts an async chat reply back
router.post('/chat-reply', async (req, res) => {
  const { chat_message_id, reply, message, text, content, response } = req.body || {};
  const replyText = reply || message || text || content || response;
  if (!chat_message_id || !String(chat_message_id).trim() || !replyText || !String(replyText).trim()) {
    return res.status(400).json({ error: 'chat_message_id and reply are required' });
  }

  try {
    const connection = await getConnectionFromCallbackToken(req, res);
    if (!connection) return;

    const today = new Date().toISOString().split('T')[0];
    const { rows: sessionRows } = await pool.query(
      `SELECT * FROM emma_sessions
       WHERE firm_id = $1 AND user_id = $2 AND session_date = $3
       LIMIT 1`,
      [connection.firm_id, connection.staff_user_id, today]
    );

    if (!sessionRows[0]) return res.status(404).json({ error: 'Chat session not found' });

    let messages = sessionRows[0].messages || [];
    if (typeof messages === 'string') {
      try { messages = JSON.parse(messages); } catch (_) { messages = []; }
    }
    if (!Array.isArray(messages)) messages = [];

    const existingReply = messages.some(m => m.role === 'assistant' && m.in_reply_to_chat_message_id === chat_message_id);
    if (existingReply) return res.json({ ok: true, duplicate: true });

    const placeholderIndex = messages.findIndex(m => m.role === 'assistant' && m.chat_message_id === chat_message_id && m.awaiting_async_reply);
    const assistantMsg = {
      role: 'assistant',
      content: String(replyText).trim(),
      timestamp: new Date().toISOString(),
      from: 'connected_agent_async',
      agent_connection_id: connection.id,
      agent_name: connection.agent_name || null,
      in_reply_to_chat_message_id: chat_message_id,
    };

    if (placeholderIndex >= 0) {
      messages[placeholderIndex] = assistantMsg;
    } else {
      messages.push(assistantMsg);
    }

    await pool.query(
      `INSERT INTO emma_sessions (firm_id, user_id, session_date, messages)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (firm_id, user_id, session_date)
       DO UPDATE SET messages = $4, updated_at = NOW()`,
      [connection.firm_id, connection.staff_user_id, today, JSON.stringify(messages)]
    );

    await auditAgentEvent({
      firmId: connection.firm_id,
      staffUserId: connection.staff_user_id,
      agentConnectionId: connection.id,
      eventType: 'chat_reply_received_callback',
      metadata: { chat_message_id },
    });

    const pusher = req.app.get('pusher');
    if (pusher) {
      pusher.trigger(`private-firm-${connection.firm_id}`, 'agent-chat-reply', {
        staffUserId: connection.staff_user_id,
        chatMessageId: chat_message_id,
        reply: String(replyText).trim(),
        agentName: connection.agent_name || null,
      }).catch(err => console.error('[agent-callbacks] pusher chat reply error:', err.message));
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[agent-callbacks] chat-reply error:', err);
    res.status(500).json({ error: 'Failed to store chat reply' });
  }
});

module.exports = router;
