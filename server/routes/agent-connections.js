'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const { pool } = require('../db');
const { encrypt, decrypt } = require('../utils/encryption');
const { auditAgentEvent, hashToken, storeMessageDraft, validateAgentEndpointUrl } = require('../services/agentConnections');
const { enqueueEmmaDraftJob } = require('../services/emmaDraftJobs');

const router = Router();

function safeConnection(row, includeCallbackToken = false, rawCallbackToken = null) {
  if (!row) return null;
  const out = {
    id: row.id,
    firm_id: row.firm_id,
    staff_user_id: row.staff_user_id,
    agent_name: row.agent_name,
    provider: row.provider,
    endpoint_url: row.endpoint_url,
    auth_type: row.auth_type,
    session_key: row.session_key,
    status: row.status,
    capabilities: row.capabilities || {},
    preferences_json: row.preferences_json || {},
    last_wake_at: row.last_wake_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (includeCallbackToken && rawCallbackToken) out.callback_token = rawCallbackToken;
  return out;
}

function normalizeCapabilities(input) {
  return {
    chat: input?.chat !== false,
    inbox_drafts: input?.inbox_drafts !== false,
    activity_log_read: input?.activity_log_read !== false,
    revenue_read: input?.revenue_read !== false,
    summaries: input?.summaries === true,
    tasks: input?.tasks === true,
  };
}

function requireStaffJwt(req, res, next) {
  if (!req.firm?.userId || req.firm?.isApiToken) {
    return res.status(400).json({ error: 'Agent connections require staff user authentication, not API-token-only auth' });
  }
  next();
}

router.use((req, res, next) => {
  if (req.path.startsWith('/callbacks/') || req.path === '/inbox-draft') return next();
  return requireStaffJwt(req, res, next);
});

// GET /api/agent-connections/mine — current staff user's connection
router.get('/mine', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM agent_connections WHERE firm_id = $1 AND staff_user_id = $2 LIMIT 1`,
      [firmId, staffUserId]
    );
    res.json({ connection: safeConnection(rows[0]) });
  } catch (err) {
    console.error('[agent-connections] GET /mine error:', err);
    res.status(500).json({ error: 'Failed to fetch agent connection' });
  }
});

// POST /api/agent-connections/mine — create/update current staff user's connection
router.post('/mine', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;

  const {
    agent_name,
    provider = 'webhook',
    endpoint_url,
    auth_type = 'none',
    auth_secret,
    session_key,
    status = 'paused',
    capabilities,
    preferences_json,
    rotate_callback_token = false,
  } = req.body || {};

  if (!agent_name || !agent_name.trim()) return res.status(400).json({ error: 'agent_name is required' });
  if (!['none', 'bearer', 'api_key'].includes(auth_type)) return res.status(400).json({ error: 'Invalid auth_type' });
  if (!['connected', 'paused', 'disabled', 'error'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    const existing = await pool.query(
      `SELECT id, callback_token_hash FROM agent_connections WHERE firm_id = $1 AND staff_user_id = $2 LIMIT 1`,
      [firmId, staffUserId]
    );

    const shouldCreateCallbackToken = rotate_callback_token || !existing.rows[0]?.callback_token_hash;
    const rawCallbackToken = shouldCreateCallbackToken ? 'dla_' + crypto.randomBytes(32).toString('hex') : null;
    const callbackHash = rawCallbackToken ? hashToken(rawCallbackToken) : null;

    const safeEndpointUrl = await validateAgentEndpointUrl(endpoint_url);
    const normalizedPreferences = preferences_json || {};
    if (status === 'connected' && !safeEndpointUrl) {
      return res.status(400).json({ error: 'endpoint_url is required before connecting an agent' });
    }
    const encryptedSecret = auth_type === 'none' ? null : (auth_secret ? encrypt(auth_secret) : null);
    const caps = normalizeCapabilities(capabilities || {});

    const { rows } = await pool.query(
      `INSERT INTO agent_connections (
         firm_id, staff_user_id, agent_name, provider, endpoint_url, auth_type, auth_secret_encrypted,
         session_key, status, capabilities, preferences_json, callback_token_hash, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (firm_id, staff_user_id) DO UPDATE SET
         agent_name = EXCLUDED.agent_name,
         provider = EXCLUDED.provider,
         endpoint_url = EXCLUDED.endpoint_url,
         auth_type = EXCLUDED.auth_type,
         auth_secret_encrypted = CASE
           WHEN EXCLUDED.auth_type = 'none' THEN NULL
           ELSE COALESCE(EXCLUDED.auth_secret_encrypted, agent_connections.auth_secret_encrypted)
         END,
         session_key = EXCLUDED.session_key,
         status = EXCLUDED.status,
         capabilities = EXCLUDED.capabilities,
         preferences_json = EXCLUDED.preferences_json,
         callback_token_hash = COALESCE(EXCLUDED.callback_token_hash, agent_connections.callback_token_hash),
         last_error = CASE WHEN EXCLUDED.status != 'error' THEN NULL ELSE agent_connections.last_error END,
         updated_at = NOW()
       RETURNING *`,
      [
        firmId,
        staffUserId,
        agent_name.trim(),
        provider,
        safeEndpointUrl,
        auth_type,
        encryptedSecret,
        session_key || null,
        status,
        JSON.stringify(caps),
        JSON.stringify(normalizedPreferences),
        callbackHash,
      ]
    );

    await auditAgentEvent({
      firmId,
      staffUserId,
      agentConnectionId: rows[0].id,
      eventType: 'agent_connection_saved',
      metadata: { provider, status },
    });

    res.status(existing.rows[0] ? 200 : 201).json({ connection: safeConnection(rows[0], !!rawCallbackToken, rawCallbackToken) });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.error('[agent-connections] POST /mine error:', err);
    res.status(500).json({ error: 'Failed to save agent connection' });
  }
});

// PATCH /api/agent-connections/mine/status — pause/enable/disable current user's connection
router.patch('/mine/status', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;
  const { status } = req.body || {};
  if (!['connected', 'paused', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    const { rows } = await pool.query(
      `UPDATE agent_connections SET status = $3, last_error = NULL, updated_at = NOW()
       WHERE firm_id = $1 AND staff_user_id = $2 RETURNING *`,
      [firmId, staffUserId, status]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Agent connection not found' });
    await auditAgentEvent({ firmId, staffUserId, agentConnectionId: rows[0].id, eventType: 'agent_connection_status_changed', metadata: { status } });
    res.json({ connection: safeConnection(rows[0]) });
  } catch (err) {
    console.error('[agent-connections] PATCH /mine/status error:', err);
    res.status(500).json({ error: 'Failed to update agent connection status' });
  }
});

// GET /api/agent-connections/drafts/:threadId — pending drafts for a thread
router.get('/drafts/:threadId', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;
  const threadId = parseInt(req.params.threadId, 10);
  if (!Number.isInteger(threadId)) return res.status(400).json({ error: 'Invalid threadId' });
  try {
    const { rows } = await pool.query(
      `SELECT md.id, md.thread_id, md.staff_user_id, md.draft_body, md.confidence, md.agent_notes,
              md.status, md.created_at, md.updated_at, ac.agent_name
       FROM message_drafts md
       LEFT JOIN agent_connections ac ON ac.id = md.agent_connection_id
       JOIN message_threads mt ON mt.id = md.thread_id AND mt.firm_id = md.firm_id
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $3 AND tp.archived_at IS NULL
       WHERE md.firm_id = $1 AND md.thread_id = $2 AND md.status = 'pending'
         AND (md.staff_user_id = $3 OR mt.staff_user_id = $3 OR tp.id IS NOT NULL)
       ORDER BY md.created_at DESC`,
      [firmId, threadId, staffUserId]
    );
    res.json({ drafts: rows });
  } catch (err) {
    console.error('[agent-connections] GET drafts error:', err);
    res.status(500).json({ error: 'Failed to fetch drafts' });
  }
});

// POST /api/agent-connections/drafts/:threadId/generate — manually request a native Emma draft
router.post('/drafts/:threadId/generate', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;
  const threadId = parseInt(req.params.threadId, 10);
  if (!Number.isInteger(threadId)) return res.status(400).json({ error: 'Invalid threadId' });

  try {
    const { rows } = await pool.query(
      `SELECT mt.id, mt.person_id, COALESCE(mt.staff_user_id, mt.assigned_to, $3) AS staff_user_id
       FROM message_threads mt
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $3 AND tp.archived_at IS NULL
       WHERE mt.id = $1 AND mt.firm_id = $2
         AND (mt.staff_user_id = $3 OR mt.assigned_to = $3 OR tp.id IS NOT NULL)
       LIMIT 1`,
      [threadId, firmId, staffUserId]
    );
    const thread = rows[0];
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const job = await enqueueEmmaDraftJob({
      firmId,
      threadId,
      personId: thread.person_id,
      staffUserId: thread.staff_user_id || staffUserId,
      requestedBy: staffUserId,
      sourceEvent: 'emma.manual_draft_requested',
      priority: 1,
    });

    await auditAgentEvent({
      firmId,
      staffUserId,
      agentConnectionId: null,
      eventType: 'emma_draft_requested',
      relatedThreadId: threadId,
      metadata: { job_id: job.id, source_event: job.source_event },
    });

    res.status(202).json({ job });
  } catch (err) {
    console.error('[agent-connections] POST generate Emma draft error:', err);
    res.status(500).json({ error: 'Failed to queue Emma draft' });
  }
});

// PATCH /api/agent-connections/drafts/:draftId — discard or mark sent by UI later
router.patch('/drafts/:draftId', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;
  const draftId = parseInt(req.params.draftId, 10);
  const { status } = req.body || {};
  if (!Number.isInteger(draftId)) return res.status(400).json({ error: 'Invalid draftId' });
  if (!['pending', 'accepted', 'edited_sent', 'discarded'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    const { rows } = await pool.query(
      `UPDATE message_drafts md
       SET status = $3, updated_at = NOW()
       FROM message_threads mt
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $4 AND tp.archived_at IS NULL
       WHERE md.id = $1 AND md.firm_id = $2 AND md.status = 'pending'
         AND mt.id = md.thread_id AND mt.firm_id = md.firm_id
         AND (md.staff_user_id = $4 OR mt.staff_user_id = $4 OR tp.id IS NOT NULL)
       RETURNING md.*`,
      [draftId, firmId, status, staffUserId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Draft not found' });
    await auditAgentEvent({ firmId, staffUserId: req.firm.userId, agentConnectionId: rows[0].agent_connection_id, eventType: 'message_draft_status_changed', relatedThreadId: rows[0].thread_id, metadata: { draft_id: draftId, status } });
    res.json({ draft: rows[0] });
  } catch (err) {
    console.error('[agent-connections] PATCH draft error:', err);
    res.status(500).json({ error: 'Failed to update draft' });
  }
});

// POST /api/agent-connections/callbacks/inbox-draft or /api/agent-callbacks/inbox-draft — connected agent posts a draft back
async function inboxDraftCallbackHandler(req, res) {
  const token = req.headers['x-darklion-agent-token'] || req.headers['x-agent-token'];
  if (!token) return res.status(401).json({ error: 'Missing agent callback token' });

  const { thread_id, draft_body, confidence, notes, agent_notes } = req.body || {};
  const threadId = parseInt(thread_id, 10);
  if (!Number.isInteger(threadId) || !draft_body || !String(draft_body).trim()) {
    return res.status(400).json({ error: 'thread_id and draft_body are required' });
  }

  try {
    const { rows: connRows } = await pool.query(
      `SELECT * FROM agent_connections WHERE callback_token_hash = $1 LIMIT 1`,
      [hashToken(token)]
    );
    const connection = connRows[0];
    if (!connection) return res.status(401).json({ error: 'Invalid agent callback token' });
    if (connection.status !== 'connected') return res.status(403).json({ error: 'Agent connection is not connected' });

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
      }).catch(err => console.error('[agent-connections] pusher draft notify error:', err.message));
    }

    res.status(201).json({ ok: true, draft_id: draft.id });
  } catch (err) {
    console.error('[agent-connections] callback error:', err);
    res.status(500).json({ error: 'Failed to store draft' });
  }
}

router.post('/callbacks/inbox-draft', inboxDraftCallbackHandler);
router.post('/inbox-draft', inboxDraftCallbackHandler);

module.exports = router;
