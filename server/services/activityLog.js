'use strict';

const { pool } = require('../db');

const EASTERN_TIME_ZONE = 'America/New_York';

function easternDateString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function intOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function normalizeEvent(row) {
  return {
    id: row.id,
    event_type: row.event_type,
    title: row.title || '',
    summary: row.summary || '',
    occurred_at: row.occurred_at,
    event_date: row.event_date,
    person_id: row.person_id,
    company_id: row.company_id,
    relationship_id: row.relationship_id,
    tax_year: row.tax_year || '',
    entity_type: row.entity_type || '',
    entity_id: row.entity_id,
    source_table: row.source_table || '',
    source_id: row.source_id || '',
    metadata: row.metadata || {},
  };
}

async function recordActivityEvent(input = {}) {
  try {
    const firmId = intOrNull(input.firmId || input.firm_id);
    const eventType = text(input.eventType || input.event_type).trim();
    if (!firmId || !eventType) return null;

    const occurredAt = input.occurredAt || input.occurred_at || new Date();
    const eventDate = input.eventDate || input.event_date || easternDateString(occurredAt);
    const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};

    const { rows } = await pool.query(
      `INSERT INTO activity_events (
         firm_id, event_type, title, summary, occurred_at, event_date,
         person_id, company_id, relationship_id, tax_year, entity_type, entity_id,
         source_table, source_id, metadata, dedupe_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (firm_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        firmId,
        eventType,
        text(input.title),
        text(input.summary),
        occurredAt,
        eventDate,
        intOrNull(input.personId || input.person_id),
        intOrNull(input.companyId || input.company_id),
        intOrNull(input.relationshipId || input.relationship_id),
        text(input.taxYear || input.tax_year),
        text(input.entityType || input.entity_type),
        intOrNull(input.entityId || input.entity_id),
        text(input.sourceTable || input.source_table),
        text(input.sourceId || input.source_id),
        JSON.stringify(metadata),
        input.dedupeKey || input.dedupe_key || null,
      ]
    );
    return rows[0] ? normalizeEvent(rows[0]) : null;
  } catch (err) {
    console.error('[activityLog] recordActivityEvent non-fatal:', err.message);
    return null;
  }
}

async function listActivityLog({ firmId, date, since, until, eventTypes = [], limit = 100 } = {}) {
  const safeFirmId = intOrNull(firmId);
  if (!safeFirmId) return [];

  const values = [safeFirmId];
  const where = ['firm_id = $1'];
  const add = value => {
    values.push(value);
    return `$${values.length}`;
  };

  if (date) {
    where.push(`event_date = ${add(date)}::date`);
  } else {
    if (since) where.push(`occurred_at >= ${add(since)}::timestamptz`);
    if (until) where.push(`occurred_at <= ${add(until)}::timestamptz`);
  }

  const types = Array.isArray(eventTypes) ? eventTypes.filter(Boolean).map(String) : [];
  if (types.length) where.push(`event_type = ANY(${add(types)}::text[])`);

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await pool.query(
    `SELECT *
     FROM activity_events
     WHERE ${where.join(' AND ')}
     ORDER BY occurred_at DESC, id DESC
     LIMIT ${safeLimit}`,
    values
  );
  return rows.map(normalizeEvent);
}

function flattenClientSummaries(summaryJson) {
  const byStaff = Array.isArray(summaryJson?.by_staff) ? summaryJson.by_staff : [];
  return byStaff.flatMap(group => (Array.isArray(group.threads) ? group.threads : []).map(thread => ({
    thread_id: thread.thread_id,
    client_name: thread.client_name,
    staff_name: thread.staff_name || group.staff_name || '',
    staff_user_id: thread.staff_user_id || group.staff_user_id || null,
    subject: thread.subject || '',
    bullets: thread.bullets || '',
    message_count: thread.message_count || 0,
  })));
}

async function getMessageSummaries(firmId, date) {
  const { rows } = await pool.query(
    `SELECT summary_json, generated_at
     FROM conversation_summaries
     WHERE firm_id = $1 AND summary_date = $2
     LIMIT 1`,
    [firmId, date]
  );
  const summaryJson = rows[0]?.summary_json || {};
  return {
    generated_at: rows[0]?.generated_at || null,
    client_threads: flattenClientSummaries(summaryJson),
    team_chats: Array.isArray(summaryJson.team_chats) ? summaryJson.team_chats : [],
  };
}

async function buildDailyAgentBrief({ firmId, date, since, until, eventTypes = [], limit = 100, includeSummaries = true } = {}) {
  const safeDate = date || (!since && !until ? easternDateString() : null);
  const events = await listActivityLog({ firmId, date: safeDate, since, until, eventTypes, limit });
  const messageSummaries = includeSummaries && safeDate
    ? await getMessageSummaries(firmId, safeDate)
    : { client_threads: [], team_chats: [], generated_at: null };

  return {
    date: safeDate,
    events,
    message_summaries: messageSummaries,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  EASTERN_TIME_ZONE,
  easternDateString,
  recordActivityEvent,
  listActivityLog,
  buildDailyAgentBrief,
};
