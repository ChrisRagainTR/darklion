'use strict';

/**
 * pipelineActions.js
 * Executes pipeline stage actions when a card moves to a stage.
 *
 * executeStageActions(firmId, stageId, pipelineInstanceId, entityType, entityId, context)
 *   - context: { pipeline_name, tax_year, stage_name }
 *   - Returns array of executed action results
 *
 * IMPORTANT: Always called non-blocking — wrap in .catch()
 */

const { pool } = require('../db');
const { sendPortalNotification } = require('./email');
const { formatPersonDisplayName } = require('../utils/displayName');
const { archiveClientMessageCreatedFailClosed } = require('./communicationArchive');

const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

// ── Merge tag substitution ──
function applyMergeTags(text, tags) {
  if (!text) return text;
  return text
    .replace(/\{First Name\}/g, tags.firstName || '')
    .replace(/\{Last Name\}/g, tags.lastName || '')
    .replace(/\{Full Name\}/g, tags.fullName || '')
    .replace(/\{Entity Name\}/g, tags.entityName || '')
    .replace(/\{Tax Year\}/g, tags.taxYear || '')
    .replace(/\{Pipeline Name\}/g, tags.pipelineName || '')
    .replace(/\{Stage Name\}/g, tags.stageName || '');
}

// ── Resolve portal-enabled people for an entity ──
async function resolvePeopleForEntity(entityType, entityId, firmId) {
  if (entityType === 'person') {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, spouse_name, email, portal_enabled
       FROM people WHERE id = $1 AND firm_id = $2`,
      [entityId, firmId]
    );
    return rows.filter(p => p.portal_enabled && p.email);
  }

  if (entityType === 'company') {
    const { rows: compRows } = await pool.query(
      'SELECT relationship_id FROM companies WHERE id = $1 AND firm_id = $2',
      [entityId, firmId]
    );
    if (!compRows[0]?.relationship_id) return [];
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, spouse_name, email, portal_enabled
       FROM people
       WHERE firm_id = $1 AND relationship_id = $2 AND portal_enabled = true AND email IS NOT NULL`,
      [firmId, compRows[0].relationship_id]
    );
    return rows;
  }

  if (entityType === 'relationship') {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, spouse_name, email, portal_enabled
       FROM people
       WHERE firm_id = $1 AND relationship_id = $2 AND portal_enabled = true AND email IS NOT NULL`,
      [firmId, entityId]
    );
    return rows;
  }

  return [];
}

// ── Resolve any person associated with entity (for staff task thread) ──
async function resolveAnyPersonForEntity(entityType, entityId, firmId) {
  if (entityType === 'person') {
    const { rows } = await pool.query(
      'SELECT id, first_name, last_name FROM people WHERE id = $1 AND firm_id = $2 LIMIT 1',
      [entityId, firmId]
    );
    return rows[0] || null;
  }

  if (entityType === 'company') {
    const { rows: compRows } = await pool.query(
      'SELECT relationship_id FROM companies WHERE id = $1 AND firm_id = $2',
      [entityId, firmId]
    );
    if (!compRows[0]?.relationship_id) return null;
    const { rows } = await pool.query(
      'SELECT id, first_name, last_name FROM people WHERE firm_id = $1 AND relationship_id = $2 LIMIT 1',
      [firmId, compRows[0].relationship_id]
    );
    return rows[0] || null;
  }

  if (entityType === 'relationship') {
    const { rows } = await pool.query(
      'SELECT id, first_name, last_name FROM people WHERE firm_id = $1 AND relationship_id = $2 LIMIT 1',
      [firmId, entityId]
    );
    return rows[0] || null;
  }

  return null;
}

// ── Get or create an open message thread for portal messaging ──
async function getOrCreatePortalThread(firmId, personId, staffUserId, subject) {
  // Prefer the thread belonging to this specific staff member
  const { rows: existing } = await pool.query(
    `SELECT id FROM message_threads
     WHERE firm_id = $1 AND person_id = $2 AND staff_user_id = $3 AND status != 'archived'
       AND category IS DISTINCT FROM 'internal'
     ORDER BY last_message_at DESC LIMIT 1`,
    [firmId, personId, staffUserId]
  );
  if (existing[0]) return existing[0].id;

  // Fall back to any open thread for this person
  const { rows: anyOpen } = await pool.query(
    `SELECT id FROM message_threads
     WHERE firm_id = $1 AND person_id = $2 AND status = 'open'
       AND category IS DISTINCT FROM 'internal'
     ORDER BY last_message_at DESC LIMIT 1`,
    [firmId, personId]
  );
  if (anyOpen[0]) return anyOpen[0].id;

  // Create new thread owned by the triggering staff member
  const { rows: created } = await pool.query(
    `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, category, last_message_at)
     VALUES ($1, $2, $3, $4, 'open', 'general', NOW()) RETURNING id`,
    [firmId, personId, staffUserId, subject || 'Pipeline Update']
  );
  return created[0].id;
}

// ── Get firm owner user id ──
async function getFirmOwnerId(firmId) {
  const { rows } = await pool.query(
    `SELECT id FROM firm_users WHERE firm_id = $1 AND role = 'owner' LIMIT 1`,
    [firmId]
  );
  return rows[0]?.id || null;
}

// ── Get firm name ──
async function getFirmName(firmId) {
  const { rows } = await pool.query('SELECT name FROM firms WHERE id = $1', [firmId]);
  return rows[0]?.name || 'Your Advisor';
}

/**
 * Main entry point.
 * @param {number} firmId
 * @param {number} stageId
 * @param {number} pipelineInstanceId
 * @param {string} entityType  'person' | 'company' | 'relationship'
 * @param {number} entityId
 * @param {object} context  { pipeline_name, tax_year, stage_name }
 */
async function executeStageActions(firmId, stageId, pipelineInstanceId, entityType, entityId, context = {}) {
  // 1. Load actions for this stage
  const { rows: actions } = await pool.query(
    `SELECT * FROM pipeline_stage_actions
     WHERE firm_id = $1 AND pipeline_instance_id = $2 AND stage_id = $3
     ORDER BY position ASC, id ASC`,
    [firmId, pipelineInstanceId, stageId]
  );

  console.log(`[pipelineActions] stage ${stageId} instance ${pipelineInstanceId}: ${actions.length} action(s) found`);
  if (!actions.length) return [];

  // 2. Resolve entity name once
  let entityName = `Entity #${entityId}`;
  try {
    if (entityType === 'person') {
      const { rows } = await pool.query(
        "SELECT first_name || ' ' || last_name AS name FROM people WHERE id = $1",
        [entityId]
      );
      entityName = rows[0]?.name || entityName;
    } else if (entityType === 'company') {
      const { rows } = await pool.query('SELECT company_name FROM companies WHERE id = $1', [entityId]);
      entityName = rows[0]?.company_name || entityName;
    } else if (entityType === 'relationship') {
      const { rows } = await pool.query('SELECT name FROM relationships WHERE id = $1', [entityId]);
      entityName = rows[0]?.name || entityName;
    }
  } catch (_) {}

  const executed = [];

  for (const action of actions) {
    try {
      if (action.action_type === 'portal_message') {
        await executePortalMessage(action, firmId, entityType, entityId, entityName, pipelineInstanceId, context);
        executed.push({ id: action.id, type: 'portal_message', ok: true });
      } else if (action.action_type === 'staff_task') {
        await executeStaffTask(action, firmId, entityType, entityId, entityName, pipelineInstanceId, context, context.job_id || null);
        executed.push({ id: action.id, type: 'staff_task', ok: true });
      }
    } catch (err) {
      console.error(`[pipelineActions] action ${action.id} (${action.action_type}) failed:`, err.message, err.stack?.split('\n').slice(0,3).join(' | '));
      executed.push({ id: action.id, type: action.action_type, ok: false, error: err.message });
    }
  }

  return executed;
}

async function executePortalMessage(action, firmId, entityType, entityId, entityName, pipelineInstanceId, context) {
  const config = action.config || {};
  const subject = config.subject || 'Pipeline Update';
  const bodyTemplate = config.body || '';

  if (!bodyTemplate.trim()) return;

  const people = await resolvePeopleForEntity(entityType, entityId, firmId);
  if (!people.length) return;

  // Use triggering user if available, fall back to firm owner
  const senderId = context.triggered_by_user_id || await getFirmOwnerId(firmId);
  const firmName = await getFirmName(firmId);

  for (const person of people) {
    const tags = {
      firstName: person.first_name || '',
      lastName: person.last_name || '',
      fullName: `${person.first_name || ''} ${person.last_name || ''}`.trim(),
      entityName,
      taxYear: context.tax_year || '',
      pipelineName: context.pipeline_name || '',
      stageName: context.stage_name || '',
    };

    const body = applyMergeTags(bodyTemplate, tags);
    const resolvedSubject = applyMergeTags(subject, tags);

    const threadId = await getOrCreatePortalThread(firmId, person.id, senderId, resolvedSubject);

    const { rows: messageRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'staff', $2, $3, false)
       RETURNING id`,
      [threadId, senderId, body]
    );
    await archiveClientMessageCreatedFailClosed({ firmId, messageId: messageRows[0].id, requestedByStaffUserId: senderId });

    await pool.query(
      `UPDATE message_threads SET last_message_at = NOW(), status = 'open' WHERE id = $1`,
      [threadId]
    );

    // Email notification — non-blocking
    if (person.email) {
      sendPortalNotification({
        to: person.email,
        name: formatPersonDisplayName(person),
        firmName,
        firmId,
        message: body.length > 300 ? body.slice(0, 297).trimEnd() + '…' : body,
        portalUrl: APP_URL + '/portal',
      }).catch(e => console.error('[pipelineActions] email notify error (non-fatal):', e.message));
    }
  }
}

async function executeStaffTask(action, firmId, entityType, entityId, entityName, pipelineInstanceId, context, jobId) {
  const config = action.config || {};
  const taskNameTemplate = config.name || 'Staff Task';
  const assignees = Array.isArray(config.assignees) ? config.assignees : [];

  if (!assignees.length) return;

  const tags = {
    firstName: '',
    lastName: '',
    fullName: '',
    entityName,
    taxYear: context.tax_year || '',
    pipelineName: context.pipeline_name || '',
    stageName: context.stage_name || '',
  };

  const taskName = applyMergeTags(taskNameTemplate, tags);

  // Link to the entity's CRM page — more useful than the pipeline board
  let entityLink = `/pipelines?instance=${pipelineInstanceId}`;
  if (entityType === 'person') {
    entityLink = `/crm/person/${entityId}`;
  } else if (entityType === 'company') {
    entityLink = `/crm/company/${entityId}`;
  } else if (entityType === 'relationship') {
    entityLink = `/crm/relationship/${entityId}`;
  }

  const messageBody = `📋 ${taskName} — ${entityName}\n\n[View ${entityName} →](${entityLink})`;

  // Find a person to anchor the thread to (required by schema)
  let anchorPerson = await resolveAnyPersonForEntity(entityType, entityId, firmId);

  // Fallback: use any portal-enabled person in the firm so the task always gets delivered
  if (!anchorPerson) {
    const { rows: anyPerson } = await pool.query(
      'SELECT id, first_name, last_name FROM people WHERE firm_id = $1 LIMIT 1',
      [firmId]
    );
    anchorPerson = anyPerson[0] || null;
  }

  for (const userId of assignees) {
    try {
      if (!anchorPerson) {
        console.log(`[pipelineActions] staff_task for user ${userId}: no person found in firm. Task: ${taskName}`);
        continue;
      }

      // Find or create an internal thread for this assignee + person combo
      const { rows: existing } = await pool.query(
        `SELECT id FROM message_threads
         WHERE firm_id = $1 AND person_id = $2 AND staff_user_id = $3
           AND category = 'internal' AND status = 'open'
         ORDER BY last_message_at DESC LIMIT 1`,
        [firmId, anchorPerson.id, userId]
      );

      let threadId;
      if (existing[0]) {
        threadId = existing[0].id;
      } else {
        const { rows: created } = await pool.query(
          `INSERT INTO message_threads
             (firm_id, person_id, staff_user_id, subject, status, category, last_message_at)
           VALUES ($1, $2, $3, $4, 'open', 'internal', NOW())
           RETURNING id`,
          [firmId, anchorPerson.id, userId, `Tasks — ${entityName}`]
        );
        threadId = created[0].id;
      }

      // Get or find the firm owner as sender, or use the assignee themselves
      const senderId = (await getFirmOwnerId(firmId)) || userId;

      const { rows: messageRows } = await pool.query(
        `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal, message_type)
         VALUES ($1, 'staff', $2, $3, true, 'task')
         RETURNING id`,
        [threadId, senderId, messageBody]
      );
      await archiveClientMessageCreatedFailClosed({ firmId, messageId: messageRows[0].id, requestedByStaffUserId: senderId });

      await pool.query(
        `UPDATE message_threads SET last_message_at = NOW() WHERE id = $1`,
        [threadId]
      );
    } catch (err) {
      console.error(`[pipelineActions] staff_task for user ${userId} failed (non-fatal):`, err.message);
    }
  }
}

module.exports = { executeStageActions };
