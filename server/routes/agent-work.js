'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Router } = require('express');
const { pool } = require('../db');
const { staffInboxPredicate } = require('../services/staffInboxVisibility');
const { encrypt, decrypt } = require('../utils/encryption');
const { auditAgentEvent, hashToken, storeMessageDraft } = require('../services/agentConnections');
const { backfillCompanyTransactions } = require('../services/transactionBackfill');
const { buildDailyAgentBrief, easternDateString } = require('../services/activityLog');
const { buildRevenueForecast } = require('../services/revenueForecast');
const { archiveTeamChatMessageCreatedFailClosed } = require('../services/communicationArchive');
const { searchFirmCrm } = require('../services/crmSearch');
const { createAgentWorkCrmRouter } = require('./agent-work-crm');
const { createAgentWorkDocumentsRouter } = require('./agent-work-documents');
const { createAgentWorkPipelinesRouter, createAgentWorkStaffRouter, createAgentWorkMyWorkRouter } = require('./agent-work-pipelines');
const { createAgentWorkCommunicationsRouter } = require('./agent-work-communications');
const { createAgentWorkBusinessRouter } = require('./agent-work-business');

const router = Router();

function intId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function hasCapability(connection, capability) {
  if (connection?.api_token_id) {
    return effectiveCapabilities(connection)[capability] === true;
  }
  return connection?.capabilities?.[capability] === true;
}

const API_TOKEN_DEFAULT_CAPABILITIES = Object.freeze({
  agent_work: true,
  inbox_read: true,
  inbox_drafts: true,
  team_chat_read: true,
  team_chat_send: true,
  documents_read: true,
  documents_write: true,
  activity_log_read: true,
  transactions_read: true,
  transactions_write: true,
  revenue_read: true,
  general_api: true,
  summaries_read: true,
  crm_read: true,
  crm_write: true,
  pipelines_read: true,
  pipelines_write: true,
  staff_read: true,
  work_read: true,
  messages_send: true,
  bookkeeping_read: true,
  tax_deliveries_read: true,
  organizers_read: true,
  proposals_read: true,
  billing_read: true,
  investments_read: true,
  engagements_read: true,
});

function effectiveCapabilities(connection) {
  const raw = connection?.capabilities || {};
  if (connection?.api_token_id) {
    const caps = { ...API_TOKEN_DEFAULT_CAPABILITIES, ...raw };
    if (raw.summaries_read === undefined && caps.general_api === false) caps.summaries_read = false;
    if (raw.crm_read === undefined && caps.general_api === false) caps.crm_read = false;
    if (raw.crm_write === undefined && caps.general_api === false) caps.crm_write = false;
    if (raw.documents_write === undefined && caps.general_api === false) caps.documents_write = false;
    for (const capability of [
      'pipelines_read', 'pipelines_write', 'staff_read', 'work_read', 'messages_send',
      'bookkeeping_read', 'tax_deliveries_read', 'organizers_read', 'proposals_read',
      'billing_read', 'investments_read', 'engagements_read',
    ]) {
      if (raw[capability] === undefined && caps.general_api === false) caps[capability] = false;
    }
    return caps;
  }
  return { ...raw };
}

function capabilityResources(capabilities) {
  const canReadSummaries = capabilities.summaries_read === true
    || (capabilities.summaries_read !== false && capabilities.general_api === true);
  return {
    summaries: {
      calendar_read: canReadSummaries,
      detail_read: canReadSummaries,
      detail_marks_viewed: false,
    },
    revenue_forecast: {
      read: capabilities.revenue_read === true,
      live_sources: true,
    },
    crm: {
      search: capabilities.crm_read === true,
      read: capabilities.crm_read === true,
      write: capabilities.crm_write === true,
    },
    documents: {
      read: capabilities.documents_read === true,
      write: capabilities.documents_write === true,
    },
    pipelines: {
      read: capabilities.pipelines_read === true,
      write: capabilities.pipelines_write === true,
    },
    staff: { read: capabilities.staff_read === true },
    work: { read: capabilities.work_read === true },
    communications: {
      summaries_read: capabilities.summaries_read === true,
      messages_send: capabilities.messages_send === true,
    },
    bookkeeping: { read: capabilities.bookkeeping_read === true },
    tax_deliveries: { read: capabilities.tax_deliveries_read === true },
    organizers: { read: capabilities.organizers_read === true },
    proposals: { read: capabilities.proposals_read === true },
    billing: { read: capabilities.billing_read === true },
    investments: { read: capabilities.investments_read === true },
    engagements: { read: capabilities.engagements_read === true },
  };
}

function bearerToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
}

async function authenticateAgent(req, res, next) {
  const callbackToken = req.headers['x-darklion-agent-token'] || req.headers['x-agent-token'];

  try {
    if (req.headers['x-darklion-internal-mcp'] === '1') {
      const token = bearerToken(req);
      if (!token) return res.status(401).json({ error: 'Missing internal MCP delegation token' });

      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET, {
          algorithms: ['HS256'],
          issuer: 'darklion-mcp',
          audience: 'darklion-agent-work',
          clockTolerance: 2,
        });
      } catch {
        return res.status(401).json({ error: 'Invalid internal MCP delegation token' });
      }

      const firmId = intId(payload.firm_id);
      const staffUserId = intId(payload.staff_user_id);
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
      if (!firmId || !staffUserId) {
        return res.status(401).json({ error: 'Invalid internal MCP delegation context' });
      }

      const { rows } = await pool.query(
        `SELECT id, role, COALESCE(NULLIF(display_name,''), NULLIF(name,''), email) AS name
         FROM firm_users
         WHERE id = $1 AND firm_id = $2 AND accepted_at IS NOT NULL AND archived_at IS NULL
         LIMIT 1`,
        [staffUserId, firmId]
      );
      if (!rows[0]) return res.status(401).json({ error: 'MCP staff scope is inactive' });

      const canRead = scopes.includes('darklion:read');
      const canWrite = scopes.includes('darklion:write');
      const canCommunicate = scopes.includes('darklion:communicate');
      req.agentConnection = {
        id: null,
        firm_id: firmId,
        staff_user_id: staffUserId,
        agent_name: rows[0].name || 'DarkLion MCP',
        status: 'connected',
        capabilities: {
          agent_work: canRead || canWrite,
          activity_log_read: canRead,
          revenue_read: canRead,
          transactions_read: canRead,
          transactions_write: canWrite,
          inbox_read: canRead,
          inbox_drafts: canWrite,
          team_chat_read: canRead,
          team_chat_send: canWrite,
          crm_read: canRead,
          crm_write: canWrite,
          documents_read: canRead,
          documents_write: canWrite,
          pipelines_read: canRead,
          pipelines_write: canWrite,
          staff_read: canRead,
          work_read: canRead,
          summaries_read: canRead,
          messages_send: canCommunicate,
          bookkeeping_read: canRead,
          tax_deliveries_read: canRead,
          organizers_read: canRead,
          proposals_read: canRead,
          billing_read: canRead,
          investments_read: canRead,
          engagements_read: canRead,
        },
        mcp_client_id: payload.client_id || null,
      };
      req.agentFirmId = firmId;
      req.agentStaffUserId = staffUserId;
      req.agentMcpClientId = payload.client_id || null;
      return next();
    }

    if (req.firm?.isApiToken) {
      const staffUserId = req.firm.userId;
      if (!staffUserId) return res.status(403).json({ error: 'This API key is not assigned to a staff/agent identity. Assign it in Settings → API Keys before using Agent Work.' });
      const scopes = req.firm.tokenScopes || {};
      if (scopes.agent_work === false) return res.status(403).json({ error: 'API key is not enabled for Agent Work' });
      req.agentConnection = {
        id: null,
        firm_id: req.firm.id,
        staff_user_id: staffUserId,
        agent_name: req.firm.tokenName || 'API Agent',
        status: 'connected',
        capabilities: scopes,
        api_token_id: req.firm.tokenId,
      };
      req.agentFirmId = req.firm.id;
      req.agentStaffUserId = staffUserId;
      req.agentApiTokenId = req.firm.tokenId;
      return next();
    }

    const token = callbackToken || bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer dlk_... or X-DarkLion-Agent-Token header' });

    const { rows } = await pool.query(
      `SELECT * FROM agent_connections WHERE callback_token_hash = $1 LIMIT 1`,
      [hashToken(token)]
    );
    const connection = rows[0];
    if (!connection) return res.status(401).json({ error: 'Invalid agent token' });
    if (connection.status !== 'connected') return res.status(403).json({ error: 'Agent connection is not connected' });
    req.agentConnection = connection;
    req.agentFirmId = connection.firm_id;
    req.agentStaffUserId = connection.staff_user_id;
    next();
  } catch (err) {
    console.error('[agent-work] auth error:', err);
    res.status(500).json({ error: 'Failed to authenticate agent' });
  }
}

function requireCapability(capability) {
  return async (req, res, next) => {
    if (!hasCapability(req.agentConnection, capability)) {
      await audit(req, `${capability}_denied`, { path: req.path }).catch(() => {});
      return res.status(403).json({ error: `Agent capability disabled: ${capability}` });
    }
    next();
  };
}

async function audit(req, eventType, metadata = {}, relatedThreadId = null) {
  return auditAgentEvent({
    firmId: req.agentFirmId,
    staffUserId: req.agentStaffUserId,
    agentConnectionId: req.agentConnection?.id || null,
    eventType: `agent_work_${eventType}`,
    relatedThreadId,
    metadata: {
      ...(metadata || {}),
      api_token_id: req.agentApiTokenId || null,
      mcp_client_id: req.agentMcpClientId || null,
    },
  });
}

function safeLimit(value, fallback = 25, max = 100) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function parseMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseIsoDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeOffset(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function parseEventTypes(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return raw.flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
}

function includeSummaries(value) {
  if (value === undefined || value === null || value === '') return true;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function normalizeTxnText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function resolveAgentCompany({ firmId, companyId, realmId }) {
  const params = [firmId];
  let predicate = '';
  if (intId(companyId)) {
    params.push(intId(companyId));
    predicate = `c.id = $2`;
  } else if (realmId) {
    params.push(String(realmId));
    predicate = `c.realm_id = $2`;
  } else {
    const err = new Error('company_id or realm_id is required');
    err.statusCode = 400;
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT c.id, c.realm_id, c.company_name
     FROM companies c
     WHERE c.firm_id = $1 AND ${predicate}
     LIMIT 1`,
    params
  );
  if (!rows[0]) {
    const err = new Error('Company not found');
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

function buildTransactionSearchInput(source = {}, fallbackCompanyId = null) {
  const amountObject = source.amount && typeof source.amount === 'object' ? source.amount : null;
  const dateRange = source.date_range || source.dateRange || {};
  const amount = parseMoney(amountObject ? amountObject.exact : source.amount);
  const amountNear = parseMoney(amountObject ? amountObject.near : (source.amount_near || source.amountNear));
  const amountMin = parseMoney(amountObject ? amountObject.min : (source.amount_min || source.amountMin));
  const amountMax = parseMoney(amountObject ? amountObject.max : (source.amount_max || source.amountMax));
  const tolerance = parseMoney(amountObject ? amountObject.tolerance : source.tolerance);

  return {
    companyId: fallbackCompanyId || source.company_id || source.companyId || null,
    realmId: source.realm_id || source.realmId || null,
    vendor: String(source.vendor || source.payee || source.vendor_name || source.vendorName || '').trim(),
    q: String(source.q || source.query || '').trim(),
    amount,
    amountNear,
    amountMin,
    amountMax,
    tolerance,
    dateFrom: parseIsoDate(dateRange.from || source.date_from || source.dateFrom),
    dateTo: parseIsoDate(dateRange.to || source.date_to || source.dateTo),
    status: String(source.status || '').trim().toLowerCase(),
    type: String(source.type || source.txn_type || source.txnType || '').trim(),
    source: String(source.source || '').trim().toLowerCase(),
    includeUncoded: source.include_uncoded === false || source.includeUncoded === false || source.include_uncoded === 'false' || source.includeUncoded === 'false' ? false : true,
    limit: safeLimit(source.limit, 25, 100),
    offset: safeOffset(source.offset),
  };
}

async function searchAgentTransactions(req, input) {
  const company = await resolveAgentCompany({ firmId: req.agentFirmId, companyId: input.companyId, realmId: input.realmId });
  const values = [req.agentFirmId, company.realm_id];
  const where = [];
  const add = value => {
    values.push(value);
    return `$${values.length}`;
  };

  const rawVendor = input.vendor || input.q;
  const normalizedVendor = normalizeTxnText(rawVendor);
  if (normalizedVendor) {
    const pattern = `%${normalizedVendor}%`;
    const p = add(pattern);
    where.push(`(
      LOWER(COALESCE(vendor_name,'')) LIKE ${p}
      OR LOWER(COALESCE(description,'')) LIKE ${p}
      OR LOWER(COALESCE(original_account,'')) LIKE ${p}
      OR LOWER(COALESCE(doc_number,'')) LIKE ${p}
      OR LOWER(COALESCE(memo,'')) LIKE ${p}
      OR REGEXP_REPLACE(LOWER(COALESCE(vendor_name,'') || ' ' || COALESCE(description,'')), '[^a-z0-9]+', ' ', 'g') LIKE ${p}
      OR REGEXP_REPLACE(LOWER(COALESCE(qbo_txn_type,'') || ' ' || COALESCE(doc_number,'') || ' ' || COALESCE(memo,'')), '[^a-z0-9]+', ' ', 'g') LIKE ${p}
    )`);
  }

  const exactAmount = input.amount !== null ? input.amount : null;
  const nearAmount = input.amountNear !== null ? input.amountNear : null;
  let amountOrder = null;
  if (exactAmount !== null) {
    const p = add(Math.abs(exactAmount));
    const tolerance = add(input.tolerance !== null ? Math.abs(input.tolerance) : 0.01);
    where.push(`ABS(ABS(amount) - ${p}::numeric) <= ${tolerance}::numeric`);
    amountOrder = `ABS(ABS(amount) - ${p}::numeric) ASC,`;
  } else if (nearAmount !== null) {
    const p = add(Math.abs(nearAmount));
    const defaultTolerance = Math.max(1, Math.abs(nearAmount) * 0.05);
    const tolerance = add(input.tolerance !== null ? Math.abs(input.tolerance) : defaultTolerance);
    where.push(`ABS(ABS(amount) - ${p}::numeric) <= ${tolerance}::numeric`);
    amountOrder = `ABS(ABS(amount) - ${p}::numeric) ASC,`;
  }
  if (input.amountMin !== null) where.push(`ABS(amount) >= ${add(Math.abs(input.amountMin))}::numeric`);
  if (input.amountMax !== null) where.push(`ABS(amount) <= ${add(Math.abs(input.amountMax))}::numeric`);
  if (input.dateFrom) where.push(`txn_date_parsed >= ${add(input.dateFrom)}::date`);
  if (input.dateTo) where.push(`txn_date_parsed <= ${add(input.dateTo)}::date`);
  if (input.status && input.status !== 'all') where.push(`status = ${add(input.status)}`);
  if (input.type) where.push(`LOWER(txn_type) = LOWER(${add(input.type)})`);
  if (input.source && input.source !== 'all') where.push(`source = ${add(input.source)}`);

  const limitPlaceholder = add(input.limit);
  const offsetPlaceholder = add(input.offset);
  const filterSql = where.length ? `WHERE ${where.join('\n        AND ')}` : '';
  const uncodedWhereSql = input.includeUncoded ? '' : 'AND FALSE';

  const { rows } = await pool.query(
    `WITH latest_uncoded AS (
       SELECT DISTINCT ON (bu.realm_id, bu.txn_qb_id) bu.*
       FROM bookkeeper_uncoded bu
       WHERE bu.firm_id = $1 AND bu.realm_id = $2 ${uncodedWhereSql}
       ORDER BY bu.realm_id, bu.txn_qb_id, bu.run_id DESC NULLS LAST, bu.id DESC
     ), unified AS (
       SELECT
         'transactions'::text AS source,
         t.id::text AS source_id,
         t.id,
         t.qb_id AS txn_qb_id,
         c.id AS company_id,
         c.realm_id,
         c.company_name,
         CASE WHEN t.date ~ '^\\d{4}-\\d{2}-\\d{2}' THEN LEFT(t.date, 10)::date ELSE NULL END AS txn_date_parsed,
         t.date AS txn_date,
         t.vendor_name,
         t.amount::numeric AS amount,
         t.description,
         t.original_account,
         t.coded_account,
         t.coded_by,
         t.coded_at,
         COALESCE(t.doc_number, '') AS doc_number,
         COALESCE(t.memo, '') AS memo,
         COALESCE(t.qbo_txn_type, '') AS qbo_txn_type,
         t.ai_category,
         t.ai_confidence,
         t.ai_memo,
         t.txn_type,
         t.status,
         t.created_at,
         t.updated_at,
         NULL::int AS run_id
       FROM transactions t
       JOIN companies c ON c.realm_id = t.realm_id AND c.firm_id = $1
       WHERE t.firm_id = $1 AND t.realm_id = $2

       UNION ALL

       SELECT
         'bookkeeper_uncoded'::text AS source,
         bu.id::text AS source_id,
         bu.id,
         bu.txn_qb_id,
         c.id AS company_id,
         c.realm_id,
         c.company_name,
         CASE WHEN bu.txn_date ~ '^\\d{4}-\\d{2}-\\d{2}' THEN LEFT(bu.txn_date, 10)::date ELSE NULL END AS txn_date_parsed,
         bu.txn_date,
         bu.vendor_name,
         bu.amount::numeric AS amount,
         bu.description,
         bu.original_account,
         bu.coded_account,
         bu.coded_by::text AS coded_by,
         bu.coded_at,
         ''::text AS doc_number,
         COALESCE(bu.ai_reasoning, '') AS memo,
         bu.txn_type AS qbo_txn_type,
         bu.ai_suggested_account AS ai_category,
         bu.ai_confidence::real AS ai_confidence,
         bu.ai_reasoning AS ai_memo,
         bu.txn_type,
         bu.status,
         NULL::timestamptz AS created_at,
         NULL::timestamptz AS updated_at,
         bu.run_id
       FROM latest_uncoded bu
       JOIN companies c ON c.realm_id = bu.realm_id AND c.firm_id = $1
     ), filtered AS (
       SELECT * FROM unified
       ${filterSql}
     ), counted AS (
       SELECT COUNT(*) OVER()::int AS total_count, filtered.*
       FROM filtered
       ORDER BY ${amountOrder || ''} txn_date_parsed DESC NULLS LAST, coded_at DESC NULLS LAST, id DESC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
     )
     SELECT * FROM counted`,
    values
  );

  const totalCount = rows[0]?.total_count || 0;
  const transactions = rows.map(row => ({
    id: row.id,
    source: row.source,
    source_id: row.source_id,
    transaction_id: row.txn_qb_id,
    qb_id: row.txn_qb_id,
    company_id: row.company_id,
    realm_id: row.realm_id,
    company_name: row.company_name,
    date: row.txn_date,
    vendor: row.vendor_name || '',
    vendor_name: row.vendor_name || '',
    amount: row.amount === null ? null : Number(row.amount),
    description: row.description || '',
    original_account: row.original_account || '',
    coded_account: row.coded_account || '',
    coded_by: row.coded_by || '',
    coded_at: row.coded_at,
    doc_number: row.doc_number || '',
    memo: row.memo || '',
    qbo_txn_type: row.qbo_txn_type || '',
    ai_category: row.ai_category || '',
    ai_confidence: row.ai_confidence === null ? null : Number(row.ai_confidence),
    ai_memo: row.ai_memo || '',
    txn_type: row.txn_type || '',
    status: row.status || '',
    run_id: row.run_id,
  }));

  return { company, totalCount, transactions };
}

function safeConversation(row) {
  const members = Array.isArray(row.members) ? row.members : [];
  const preview = row.preview_encrypted ? (decrypt(row.preview_encrypted) || '') : '';
  const title = row.title || row.member_names || (row.conversation_type === 'dm' ? 'Direct message' : 'Team conversation');
  return {
    id: row.id,
    conversation_id: row.id,
    conversation_type: row.conversation_type,
    title,
    unread_count: Number(row.unread_count || 0),
    last_message_at: row.last_message_at || row.updated_at,
    updated_at: row.updated_at,
    created_at: row.created_at,
    preview_text: preview,
    members,
  };
}

function safeTeamMessage(row) {
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const body = decrypt(row.body_encrypted) || '';
  return {
    id: row.id,
    message_id: row.id,
    conversation_id: row.conversation_id,
    sender_staff_user_id: row.sender_staff_user_id,
    sender_name: row.sender_name || '',
    message_kind: row.message_kind,
    body,
    text: body,
    attachments,
    created_at: row.created_at,
    direction: Number(row.sender_staff_user_id) === Number(row.current_staff_user_id) ? 'outbound' : 'inbound',
  };
}

async function listTeamConversations({ firmId, staffUserId, onlyUnread = false, limit = 50 }) {
  const { rows } = await pool.query(
    `WITH member_json AS (
       SELECT m.conversation_id,
              JSON_AGG(JSON_BUILD_OBJECT('id', u.id, 'name', COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email), 'email', u.email, 'role', u.role) ORDER BY COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email)) AS members,
              STRING_AGG(COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email), ', ' ORDER BY COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email)) AS member_names
       FROM native_team_chat_members m
       JOIN firm_users u ON u.id = m.staff_user_id AND u.firm_id = m.firm_id
       WHERE m.firm_id = $1 AND m.left_at IS NULL
       GROUP BY m.conversation_id
     ), last_msg AS (
       SELECT DISTINCT ON (conversation_id) conversation_id, body_encrypted AS preview_encrypted, created_at AS last_message_at
       FROM native_team_chat_messages
       WHERE firm_id = $1
       ORDER BY conversation_id, created_at DESC, id DESC
     )
     SELECT c.*, mj.members, mj.member_names, lm.preview_encrypted, lm.last_message_at,
            COALESCE(unread.count,0) AS unread_count
     FROM native_team_chat_conversations c
     JOIN native_team_chat_members mine ON mine.conversation_id = c.id AND mine.firm_id = c.firm_id AND mine.staff_user_id = $2 AND mine.left_at IS NULL
     LEFT JOIN native_team_chat_user_state us ON us.conversation_id = c.id AND us.firm_id = c.firm_id AND us.staff_user_id = $2
     LEFT JOIN native_team_chat_read_state rs ON rs.conversation_id = c.id AND rs.firm_id = c.firm_id AND rs.staff_user_id = $2
     LEFT JOIN member_json mj ON mj.conversation_id = c.id
     LEFT JOIN last_msg lm ON lm.conversation_id = c.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS count
       FROM native_team_chat_messages msg
       WHERE msg.firm_id = c.firm_id AND msg.conversation_id = c.id AND msg.sender_staff_user_id IS DISTINCT FROM $2
         AND (rs.last_read_message_id IS NULL OR msg.id > rs.last_read_message_id)
     ) unread ON TRUE
     WHERE c.firm_id = $1
       AND COALESCE(us.is_archived,FALSE) = FALSE
       AND COALESCE(us.is_hidden,FALSE) = FALSE
       AND ($4::boolean = FALSE OR COALESCE(unread.count,0) > 0)
     ORDER BY COALESCE(unread.count,0) DESC, COALESCE(lm.last_message_at, c.updated_at) DESC
     LIMIT $3`,
    [firmId, staffUserId, limit, !!onlyUnread]
  );
  return rows.map(safeConversation);
}

async function listTeamMessages({ firmId, staffUserId, conversationId, limit = 50 }) {
  const member = await pool.query(
    `SELECT 1 FROM native_team_chat_members WHERE firm_id = $1 AND conversation_id = $2 AND staff_user_id = $3 AND left_at IS NULL LIMIT 1`,
    [firmId, conversationId, staffUserId]
  );
  if (!member.rows[0]) {
    const err = new Error('Team Chat conversation not found');
    err.statusCode = 404;
    throw err;
  }
  const { rows } = await pool.query(
    `WITH attachment_json AS (
       SELECT message_id,
              JSON_AGG(JSON_BUILD_OBJECT('id', id, 'file_name', file_name, 'content_type', content_type, 'byte_size', byte_size, 'sha256', sha256, 'metadata', metadata) ORDER BY id) AS attachments
       FROM native_team_chat_attachments
       WHERE firm_id = $1
       GROUP BY message_id
     )
     SELECT msg.*, $2::int AS current_staff_user_id, COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), u.email, 'Unknown') AS sender_name,
            COALESCE(att.attachments, '[]'::json) AS attachments
     FROM native_team_chat_messages msg
     LEFT JOIN firm_users u ON u.id = msg.sender_staff_user_id AND u.firm_id = msg.firm_id
     LEFT JOIN attachment_json att ON att.message_id = msg.id
     WHERE msg.firm_id = $1 AND msg.conversation_id = $3
     ORDER BY msg.created_at DESC, msg.id DESC
     LIMIT $4`,
    [firmId, staffUserId, conversationId, limit]
  );
  return rows.reverse().map(safeTeamMessage);
}

async function markTeamRead({ firmId, staffUserId, conversationId, messageId = null }) {
  const finalMessageId = intId(messageId) || (await pool.query(
    `SELECT id FROM native_team_chat_messages WHERE firm_id = $1 AND conversation_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [firmId, conversationId]
  )).rows[0]?.id || null;
  if (!finalMessageId) return null;
  const { rows } = await pool.query(
    `INSERT INTO native_team_chat_read_state (firm_id, conversation_id, staff_user_id, last_read_message_id, last_read_at, updated_at)
     VALUES ($1,$2,$3,$4,NOW(),NOW())
     ON CONFLICT (firm_id, conversation_id, staff_user_id) DO UPDATE SET
       last_read_message_id = GREATEST(COALESCE(native_team_chat_read_state.last_read_message_id, 0), COALESCE(EXCLUDED.last_read_message_id, 0)),
       last_read_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [firmId, conversationId, staffUserId, finalMessageId]
  );
  return rows[0];
}

async function broadcastTeamMessage(req, { conversationId, message }) {
  const pusher = req.app.get('pusher');
  if (!pusher || !message?.id) return;
  const { rows } = await pool.query(
    `SELECT staff_user_id FROM native_team_chat_members WHERE firm_id = $1 AND conversation_id = $2 AND left_at IS NULL`,
    [req.agentFirmId, conversationId]
  );
  await Promise.all(rows.map(row => pusher.trigger(
    `private-team-chat-${req.agentFirmId}-${row.staff_user_id}`,
    'team-chat-message',
    {
      conversation_id: conversationId,
      message_id: message.id,
      sender_staff_user_id: message.sender_staff_user_id,
      sent_at: message.created_at || new Date().toISOString(),
      message: safeTeamMessage({ ...message, current_staff_user_id: req.agentStaffUserId, sender_name: req.agentConnection.agent_name || 'Agent', attachments: [] }),
    }
  )));
}

router.use(authenticateAgent);
router.use((req,res,next)=>require('../services/subscriptions').requireSubscription({
  firm:{id:req.agentFirmId},method:req.method,originalUrl:req.originalUrl,
},res,next));

router.get('/status', async (req, res) => {
  await audit(req, 'status_checked', { path: req.path }).catch(() => {});
  const capabilities = effectiveCapabilities(req.agentConnection);
  res.json({
    ok: true,
    firm_id: req.agentFirmId,
    staff_user_id: req.agentStaffUserId,
    agent_connection_id: req.agentConnection.id,
    agent_name: req.agentConnection.agent_name,
    capabilities,
    resources: capabilityResources(capabilities),
  });
});

router.get('/companies', requireCapability('transactions_read'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.realm_id, c.company_name, c.entity_type, c.status
       FROM companies c
       WHERE c.firm_id = $1
         AND c.archived_at IS NULL
         AND (
           NOT EXISTS (
             SELECT 1 FROM firm_user_companies restricted
             WHERE restricted.firm_user_id = $2
           )
           OR EXISTS (
             SELECT 1 FROM firm_user_companies allowed
             WHERE allowed.firm_user_id = $2 AND allowed.realm_id = c.realm_id
           )
         )
       ORDER BY c.company_name ASC, c.id ASC`,
      [req.agentFirmId, req.agentStaffUserId]
    );
    await audit(req, 'companies_listed', { count: rows.length }).catch(() => {});
    res.json({ companies: rows });
  } catch (err) {
    console.error('[agent-work] companies error:', err);
    res.status(500).json({ error: 'Failed to list companies' });
  }
});

router.get('/crm/search', requireCapability('crm_read'), async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query || query.length > 200) {
    return res.status(400).json({ error: 'q is required and must be 200 characters or fewer' });
  }
  const limit = safeLimit(req.query.limit, 10, 25);
  try {
    const result = await searchFirmCrm({ firmId: req.agentFirmId, query, limit });
    await audit(req, 'crm_searched', {
      relationship_count: result.relationships.length,
      company_count: result.companies.length,
      people_count: result.people.length,
    }).catch(() => {});
    return res.json(result);
  } catch (err) {
    console.error('[agent-work] CRM search error:', err);
    return res.status(500).json({ error: 'CRM search failed' });
  }
});

router.use('/crm', createAgentWorkCrmRouter({ requireCapability, audit }));
router.use('/documents', createAgentWorkDocumentsRouter({ audit, requireCapability }));
router.use('/pipelines', createAgentWorkPipelinesRouter({ requireCapability, audit }));
router.use('/staff', createAgentWorkStaffRouter({ requireCapability, audit }));
router.use('/my-work', createAgentWorkMyWorkRouter({ requireCapability, audit }));
router.use('/communications', createAgentWorkCommunicationsRouter({ audit, requireCapability }));
router.use('/business', createAgentWorkBusinessRouter({ audit, requireCapability }));

router.get('/activity-log', requireCapability('activity_log_read'), async (req, res) => {
  try {
    const date = parseIsoDate(req.query.date) || (!req.query.since && !req.query.until ? easternDateString() : null);
    const brief = await buildDailyAgentBrief({
      firmId: req.agentFirmId,
      date,
      since: req.query.since || null,
      until: req.query.until || null,
      eventTypes: parseEventTypes(req.query.event_type || req.query.eventType),
      limit: safeLimit(req.query.limit, 100, 500),
      includeSummaries: includeSummaries(req.query.include_summaries ?? req.query.includeSummaries),
    });
    await audit(req, 'activity_log_read', {
      date: brief.date,
      event_count: brief.events.length,
      include_summaries: includeSummaries(req.query.include_summaries ?? req.query.includeSummaries),
    }).catch(() => {});
    res.json(brief);
  } catch (err) {
    console.error('[agent-work] activity log error:', err);
    res.status(500).json({ error: 'Failed to fetch activity log' });
  }
});

router.get('/revenue-forecast', requireCapability('revenue_read'), async (req, res) => {
  const currentYear = new Date().getFullYear();
  const requestedYear = req.query.year === undefined ? currentYear : Number(req.query.year);
  if (!Number.isInteger(requestedYear) || requestedYear < 2000 || requestedYear > currentYear + 10) {
    return res.status(400).json({ error: `year must be an integer from 2000 through ${currentYear + 10}` });
  }

  try {
    const forecast = await buildRevenueForecast({
      firmId: req.agentFirmId,
      year: requestedYear,
    });
    await audit(req, 'revenue_forecast_read', {
      year: forecast.year,
      customer_count: forecast.customers.length,
      annual: forecast.totals.annual,
      collected: forecast.totals.collected,
      past_due: forecast.totals.pastDue,
      upcoming: forecast.totals.upcoming,
    }).catch(() => {});
    res.json(forecast);
  } catch (err) {
    console.error('[agent-work] revenue forecast error:', err);
    res.status(500).json({ error: 'Failed to build revenue forecast' });
  }
});

router.get('/companies/:companyId/transactions/search', requireCapability('transactions_read'), async (req, res) => {
  try {
    const input = buildTransactionSearchInput(req.query, req.params.companyId);
    const result = await searchAgentTransactions(req, input);
    await audit(req, 'transactions_searched', {
      company_id: result.company.id,
      realm_id: result.company.realm_id,
      vendor: input.vendor || input.q || null,
      amount: input.amount,
      amount_near: input.amountNear,
      amount_min: input.amountMin,
      amount_max: input.amountMax,
      date_from: input.dateFrom,
      date_to: input.dateTo,
      returned: result.transactions.length,
    }).catch(() => {});
    res.json({
      company: result.company,
      query: input,
      count: result.transactions.length,
      total_count: result.totalCount,
      limit: input.limit,
      offset: input.offset,
      transactions: result.transactions,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('[agent-work] transaction search error:', err);
    res.status(status).json({ error: err.message || 'Failed to search transactions' });
  }
});

router.post('/transactions/search', requireCapability('transactions_read'), async (req, res) => {
  try {
    const input = buildTransactionSearchInput(req.body || {});
    const result = await searchAgentTransactions(req, input);
    await audit(req, 'transactions_searched', {
      company_id: result.company.id,
      realm_id: result.company.realm_id,
      vendor: input.vendor || input.q || null,
      amount: input.amount,
      amount_near: input.amountNear,
      amount_min: input.amountMin,
      amount_max: input.amountMax,
      date_from: input.dateFrom,
      date_to: input.dateTo,
      returned: result.transactions.length,
    }).catch(() => {});
    res.json({
      company: result.company,
      query: input,
      count: result.transactions.length,
      total_count: result.totalCount,
      limit: input.limit,
      offset: input.offset,
      transactions: result.transactions,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('[agent-work] transaction search error:', err);
    res.status(status).json({ error: err.message || 'Failed to search transactions' });
  }
});

router.post('/companies/:companyId/transactions/backfill', requireCapability('transactions_write'), async (req, res) => {
  const companyId = intId(req.params.companyId);
  if (!companyId) return res.status(400).json({ error: 'Invalid companyId' });
  try {
    const result = await backfillCompanyTransactions({
      firmId: req.agentFirmId,
      companyId,
      months: req.body?.months || 24,
      types: req.body?.types || null,
    });
    await audit(req, 'transactions_backfilled', {
      company_id: result.company.id,
      realm_id: result.company.realm_id,
      months: result.months,
      start_date: result.start_date,
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors,
    }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('[agent-work] transaction backfill error:', err);
    res.status(status).json({ error: err.message || 'Failed to backfill transactions' });
  }
});

router.post('/transactions/backfill', requireCapability('transactions_write'), async (req, res) => {
  try {
    const result = await backfillCompanyTransactions({
      firmId: req.agentFirmId,
      companyId: intId(req.body?.company_id || req.body?.companyId),
      realmId: req.body?.realm_id || req.body?.realmId || null,
      months: req.body?.months || 24,
      types: req.body?.types || null,
    });
    await audit(req, 'transactions_backfilled', {
      company_id: result.company.id,
      realm_id: result.company.realm_id,
      months: result.months,
      start_date: result.start_date,
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors,
    }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('[agent-work] transaction backfill error:', err);
    res.status(status).json({ error: err.message || 'Failed to backfill transactions' });
  }
});

router.get('/inbox/summary', requireCapability('inbox_read'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH visible_threads AS (
         SELECT mt.id
         FROM message_threads mt
         LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $2
         WHERE mt.firm_id = $1 AND ${staffInboxPredicate()}
       )
       SELECT
         (SELECT COUNT(*)::int FROM visible_threads) AS open_threads,
         (SELECT COUNT(*)::int FROM messages m JOIN visible_threads vt ON vt.id = m.thread_id WHERE m.sender_type = 'client' AND m.removed_at IS NULL AND m.read_at IS NULL) AS unread_messages,
         (SELECT COUNT(*)::int FROM message_drafts md JOIN visible_threads vt ON vt.id = md.thread_id WHERE md.status = 'pending') AS pending_drafts`,
      [req.agentFirmId, req.agentStaffUserId]
    );
    await audit(req, 'inbox_summary_read', {}).catch(() => {});
    res.json({ summary: rows[0] || { open_threads: 0, unread_messages: 0, pending_drafts: 0 } });
  } catch (err) {
    console.error('[agent-work] inbox summary error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox summary' });
  }
});

router.get('/inbox/threads', requireCapability('inbox_read'), async (req, res) => {
  try {
    const limit = safeLimit(req.query.limit, 25, 100);
    const unreadOnly = req.query.unread === 'true';
    const { rows } = await pool.query(
      `SELECT mt.id, mt.subject, mt.status, mt.category, mt.last_message_at, mt.created_at,
              CASE WHEN mt.staff_user_id = $2 THEN mt.staff_archived_at ELSE tp.archived_at END AS archived_for_user_at,
              p.id AS person_id, p.first_name, p.last_name, p.email AS person_email,
              fu.name AS staff_name, fu.display_name AS staff_display_name,
              (mt.staff_user_id != $2) AS is_participant,
              (SELECT body FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT created_at FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_message_at_sub,
              (SELECT COUNT(*)::int FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count,
              (SELECT COUNT(*)::int FROM message_drafts md WHERE md.thread_id = mt.id AND md.status = 'pending') AS pending_draft_count
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       JOIN firm_users fu ON fu.id = mt.staff_user_id
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $2
       WHERE mt.firm_id = $1 AND ${staffInboxPredicate('$2', '$5')}
         AND ($4::boolean = FALSE OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.sender_type = 'client' AND m.read_at IS NULL))
       ORDER BY mt.last_message_at DESC NULLS LAST
       LIMIT $3`,
      [req.agentFirmId, req.agentStaffUserId, limit, unreadOnly, req.query.view === 'archived']
    );
    await audit(req, 'inbox_threads_listed', { count: rows.length, unread_only: unreadOnly }).catch(() => {});
    res.json({ threads: rows.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      isArchived: req.query.view === 'archived',
      archivedAt: t.archived_for_user_at,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      isParticipant: t.is_participant,
      staffName: t.staff_display_name || t.staff_name,
      person: { id: t.person_id, firstName: t.first_name, lastName: t.last_name, email: t.person_email },
      lastPreview: t.last_body ? String(t.last_body).slice(0, 160) : '',
      unreadCount: Number(t.unread_count || 0),
      pendingDraftCount: Number(t.pending_draft_count || 0),
    })) });
  } catch (err) {
    console.error('[agent-work] inbox threads error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox threads' });
  }
});

router.get('/inbox/threads/:threadId', requireCapability('inbox_read'), async (req, res) => {
  const threadId = intId(req.params.threadId);
  if (!threadId) return res.status(400).json({ error: 'Invalid threadId' });
  try {
    const { rows: threadRows } = await pool.query(
      `SELECT mt.*, p.first_name, p.last_name, p.email, p.phone, r.name AS relationship_name,
              (mt.staff_user_id = $3 OR tp.id IS NOT NULL) AS is_visible,
              CASE WHEN mt.staff_user_id = $3 THEN mt.staff_archived_at ELSE tp.archived_at END AS archived_for_user_at,
              CASE WHEN mt.staff_user_id = $3 THEN (mt.staff_archived_at IS NOT NULL OR mt.status = 'archived')
                   ELSE tp.archived_at IS NOT NULL END AS is_archived_for_user
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN relationships r ON r.id = p.relationship_id
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $3
       WHERE mt.id = $1 AND mt.firm_id = $2
       LIMIT 1`,
      [threadId, req.agentFirmId, req.agentStaffUserId]
    );
    const thread = threadRows[0];
    if (!thread || !thread.is_visible) return res.status(404).json({ error: 'Thread not found' });

    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.sender_type, m.sender_id, m.body, m.is_internal, m.message_type, m.created_at, m.read_at,
              CASE WHEN m.sender_type = 'staff' THEN COALESCE(NULLIF(fu.display_name, ''), NULLIF(fu.name, ''), fu.email)
                   WHEN m.sender_type = 'client' THEN CONCAT($2::text, ' ', $3::text)
                   ELSE 'Agent' END AS sender_name
       FROM messages m
       LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
       WHERE m.thread_id = $1 AND m.removed_at IS NULL
       ORDER BY m.created_at ASC
       LIMIT 100`,
      [threadId, thread.first_name || '', thread.last_name || '']
    );
    const { rows: drafts } = await pool.query(
      `SELECT md.id, md.draft_body, md.confidence, md.agent_notes, md.status, md.created_at, ac.agent_name
       FROM message_drafts md
       LEFT JOIN agent_connections ac ON ac.id = md.agent_connection_id
       WHERE md.firm_id = $1 AND md.thread_id = $2 AND md.status = 'pending'
       ORDER BY md.created_at DESC`,
      [req.agentFirmId, threadId]
    );
    await audit(req, 'inbox_thread_read', { message_count: msgs.length }, threadId).catch(() => {});
    res.json({
      thread: {
        id: thread.id,
        subject: thread.subject,
        status: thread.status,
        isArchived: thread.is_archived_for_user,
        archivedAt: thread.archived_for_user_at,
        category: thread.category,
        lastMessageAt: thread.last_message_at,
        person: { id: thread.person_id, firstName: thread.first_name, lastName: thread.last_name, email: thread.email, phone: thread.phone, relationshipName: thread.relationship_name },
      },
      messages: msgs.map(m => ({
        id: m.id,
        senderType: m.sender_type,
        senderId: m.sender_id,
        senderName: m.sender_name,
        body: m.body,
        isInternal: m.is_internal,
        messageType: m.message_type || 'message',
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
      pendingDrafts: drafts.map(d => ({ id: d.id, draftBody: d.draft_body, confidence: d.confidence, agentNotes: d.agent_notes, agentName: d.agent_name, createdAt: d.created_at })),
    });
  } catch (err) {
    console.error('[agent-work] inbox thread error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox thread' });
  }
});

router.post('/inbox/threads/:threadId/draft', requireCapability('inbox_drafts'), async (req, res) => {
  const threadId = intId(req.params.threadId);
  const draftBody = String(req.body?.draft_body || req.body?.draftBody || req.body?.draft || '').trim();
  if (!threadId || !draftBody) return res.status(400).json({ error: 'threadId and draft_body are required' });
  try {
    const { rows } = await pool.query(
      `SELECT mt.id, mt.staff_user_id
       FROM message_threads mt
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $3 AND tp.archived_at IS NULL
       WHERE mt.id = $1 AND mt.firm_id = $2 AND (mt.staff_user_id = $3 OR tp.id IS NOT NULL)
       LIMIT 1`,
      [threadId, req.agentFirmId, req.agentStaffUserId]
    );
    const thread = rows[0];
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const draft = await storeMessageDraft({
      firmId: req.agentFirmId,
      threadId,
      staffUserId: thread.staff_user_id || req.agentStaffUserId,
      agentConnectionId: req.agentConnection.id,
      draftBody,
      confidence: req.body?.confidence ?? null,
      agentNotes: req.body?.notes || req.body?.agent_notes || null,
      sourceEvent: 'agent_work.inbox_draft',
    });
    await audit(req, 'inbox_draft_created', { draft_id: draft.id }, threadId).catch(() => {});
    const pusher = req.app.get('pusher');
    if (pusher) {
      pusher.trigger(`private-firm-${req.agentFirmId}`, 'agent-draft-new', {
        threadId,
        draftId: draft.id,
        staffUserId: draft.staff_user_id,
      }).catch(err => console.error('[agent-work] draft pusher error:', err.message));
    }
    res.status(201).json({ ok: true, draft_id: draft.id, draft });
  } catch (err) {
    console.error('[agent-work] inbox draft error:', err);
    res.status(500).json({ error: 'Failed to create inbox draft' });
  }
});

router.get('/team-chat/summary', requireCapability('team_chat_read'), async (req, res) => {
  try {
    const conversations = await listTeamConversations({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, onlyUnread: true, limit: 100 });
    await audit(req, 'team_chat_summary_read', { unread_conversations: conversations.length }).catch(() => {});
    res.json({
      summary: {
        unread_conversations: conversations.length,
        unread_count: conversations.reduce((sum, c) => sum + Number(c.unread_count || 0), 0),
      },
      conversations,
    });
  } catch (err) {
    console.error('[agent-work] team summary error:', err);
    res.status(500).json({ error: 'Failed to fetch Team Chat summary' });
  }
});

router.get('/team-chat/conversations', requireCapability('team_chat_read'), async (req, res) => {
  try {
    const conversations = await listTeamConversations({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, onlyUnread: req.query.unread === 'true', limit: safeLimit(req.query.limit, 50, 100) });
    await audit(req, 'team_chat_conversations_listed', { count: conversations.length }).catch(() => {});
    res.json({ conversations });
  } catch (err) {
    console.error('[agent-work] team conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch Team Chat conversations' });
  }
});

router.get('/team-chat/conversations/:conversationId/messages', requireCapability('team_chat_read'), async (req, res) => {
  const conversationId = intId(req.params.conversationId);
  if (!conversationId) return res.status(400).json({ error: 'Invalid conversationId' });
  try {
    const messages = await listTeamMessages({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, conversationId, limit: safeLimit(req.query.limit, 50, 100) });
    await audit(req, 'team_chat_messages_read', { conversation_id: conversationId, message_count: messages.length }).catch(() => {});
    res.json({ conversation_id: conversationId, messages });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('[agent-work] team messages error:', err);
    res.status(status).json({ error: err.message || 'Failed to fetch Team Chat messages' });
  }
});

router.post('/team-chat/conversations/:conversationId/reply', requireCapability('team_chat_send'), async (req, res) => {
  const conversationId = intId(req.params.conversationId);
  const body = String(req.body?.body || req.body?.message || req.body?.text || '').replace(/^\n+|\n+$/g, '');
  if (!conversationId || !body) return res.status(400).json({ error: 'conversationId and body are required' });
  try {
    const member = await pool.query(
      `SELECT 1 FROM native_team_chat_members WHERE firm_id = $1 AND conversation_id = $2 AND staff_user_id = $3 AND left_at IS NULL LIMIT 1`,
      [req.agentFirmId, conversationId, req.agentStaffUserId]
    );
    if (!member.rows[0]) return res.status(404).json({ error: 'Team Chat conversation not found' });
    const nonce = String(req.body?.client_nonce || req.body?.clientNonce || `agent-${crypto.randomUUID()}`);
    const sha = crypto.createHash('sha256').update(`${req.agentFirmId}:${conversationId}:${req.agentStaffUserId}:${body}:agent-work`).digest('hex');
    const { rows } = await pool.query(
      `INSERT INTO native_team_chat_messages (firm_id, conversation_id, sender_staff_user_id, message_kind, body_encrypted, immutable_sha256, client_nonce, metadata)
       VALUES ($1,$2,$3,'text',$4,$5,$6,$7)
       ON CONFLICT (firm_id, conversation_id, client_nonce) DO NOTHING
       RETURNING *`,
      [req.agentFirmId, conversationId, req.agentStaffUserId, encrypt(body), sha, nonce, JSON.stringify({ source: 'agent_work', agent_connection_id: req.agentConnection.id })]
    );
    const wasInserted = Boolean(rows[0]);
    let inserted = rows[0];
    if (!inserted) {
      const existing = await pool.query(
        `SELECT * FROM native_team_chat_messages WHERE firm_id = $1 AND conversation_id = $2 AND client_nonce = $3 LIMIT 1`,
        [req.agentFirmId, conversationId, nonce]
      );
      inserted = existing.rows[0];
    } else {
      await pool.query(`UPDATE native_team_chat_conversations SET updated_at = NOW() WHERE firm_id = $1 AND id = $2`, [req.agentFirmId, conversationId]);
    }
    if (wasInserted) {
      await archiveTeamChatMessageCreatedFailClosed({
        firmId: req.agentFirmId,
        messageId: inserted.id,
        requestedByStaffUserId: req.agentStaffUserId,
      });
      await markTeamRead({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, conversationId, messageId: inserted.id }).catch(() => {});
      await audit(req, 'team_chat_reply_sent', { conversation_id: conversationId, message_id: inserted.id }, null).catch(() => {});
      await broadcastTeamMessage(req, { conversationId, message: inserted }).catch(err => console.error('[agent-work] team broadcast error:', err.message));
    } else {
      await audit(req, 'team_chat_reply_replayed', { conversation_id: conversationId, message_id: inserted.id }, null).catch(() => {});
    }
    const [message] = await listTeamMessages({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, conversationId, limit: 1 });
    res.status(201).json({ ok: true, message });
  } catch (err) {
    console.error('[agent-work] team reply error:', err);
    res.status(500).json({ error: 'Failed to send Team Chat reply' });
  }
});

module.exports = router;
