'use strict';

const { pool } = require('../db');
const { executeStageActions } = require('./pipelineActions');

class AgentPipelineError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AgentPipelineError';
    this.statusCode = statusCode;
  }
}

function positiveId(value, field = 'id') {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new AgentPipelineError(`${field} must be a positive integer`);
  return parsed;
}

function boundedLimit(value, fallback = 100, maximum = 200) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function jobDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    instance_id: row.instance_id,
    instance_name: row.instance_name,
    template_id: row.template_id,
    template_name: row.template_name,
    tax_year: row.tax_year,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    relationship_id: row.relationship_id,
    current_stage_id: row.current_stage_id,
    stage_name: row.stage_name,
    stage_position: row.stage_position,
    status: row.job_status || row.status,
    assigned_to: row.assigned_to,
    assigned_name: row.assigned_name,
    priority: row.priority,
    due_date: row.due_date,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const JOB_SELECT = `
  SELECT pj.id, pj.instance_id, pi.name AS instance_name, pi.tax_year,
         pt.id AS template_id, pt.name AS template_name,
         pj.entity_type, pj.entity_id,
         CASE pj.entity_type
           WHEN 'company' THEN c.company_name
           WHEN 'person' THEN NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '')
           WHEN 'relationship' THEN direct_r.name
         END AS entity_name,
         COALESCE(c.relationship_id, p.relationship_id, direct_r.id) AS relationship_id,
         pj.current_stage_id, ps.name AS stage_name, ps.position AS stage_position,
         pj.job_status, pj.assigned_to, COALESCE(NULLIF(fu.display_name, ''), fu.name) AS assigned_name,
         pj.priority, pj.due_date, pj.notes, pj.created_at, pj.updated_at
  FROM pipeline_jobs pj
  JOIN pipeline_instances pi ON pi.id = pj.instance_id
  JOIN pipeline_templates pt ON pt.id = pi.template_id AND pt.firm_id = pi.firm_id
  LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id AND ps.template_id = pt.id
  LEFT JOIN companies c ON c.id = pj.entity_id AND c.firm_id = pi.firm_id AND pj.entity_type = 'company'
  LEFT JOIN people p ON p.id = pj.entity_id AND p.firm_id = pi.firm_id AND pj.entity_type = 'person'
  LEFT JOIN relationships direct_r ON direct_r.id = pj.entity_id AND direct_r.firm_id = pi.firm_id AND pj.entity_type = 'relationship'
  LEFT JOIN firm_users fu ON fu.id = pj.assigned_to AND fu.firm_id = pi.firm_id`;

async function listPipelineJobs({ firmId, assignedTo, instanceId, includeCompleted = false, limit, db = pool }) {
  const params = [firmId];
  const filters = ['pi.firm_id = $1'];
  if (!includeCompleted) filters.push("COALESCE(pj.job_status, 'active') NOT IN ('complete','completed','archived')");
  if (assignedTo !== undefined) {
    params.push(positiveId(assignedTo, 'assigned_to'));
    filters.push(`pj.assigned_to = $${params.length}`);
  }
  if (instanceId !== undefined) {
    params.push(positiveId(instanceId, 'instance_id'));
    filters.push(`pj.instance_id = $${params.length}`);
  }
  params.push(boundedLimit(limit));
  const { rows } = await db.query(`${JOB_SELECT}
    WHERE ${filters.join(' AND ')}
    ORDER BY ps.position ASC NULLS LAST, pj.updated_at DESC, pj.id ASC
    LIMIT $${params.length}`, params);
  return rows.map(jobDto);
}

async function getPipelineJob({ firmId, jobId, db = pool }) {
  const id = positiveId(jobId, 'job_id');
  const { rows } = await db.query(`${JOB_SELECT} WHERE pi.firm_id = $1 AND pj.id = $2`, [firmId, id]);
  if (!rows[0]) throw new AgentPipelineError('Pipeline job not found', 404);
  return jobDto(rows[0]);
}

async function listTemplateStages({ firmId, templateId, db = pool }) {
  const id = positiveId(templateId, 'template_id');
  const { rows } = await db.query(`
    SELECT ps.id, ps.template_id, ps.name, ps.position, ps.color,
           ps.is_terminal, COALESCE(ps.hold_for_migration, false) AS hold_for_migration
    FROM pipeline_stages ps
    JOIN pipeline_templates pt ON pt.id = ps.template_id
    WHERE ps.template_id = $1 AND pt.firm_id = $2
    ORDER BY ps.position ASC, ps.id ASC`, [id, firmId]);
  if (!rows.length) {
    const template = await db.query('SELECT id FROM pipeline_templates WHERE id = $1 AND firm_id = $2', [id, firmId]);
    if (!template.rows[0]) throw new AgentPipelineError('Pipeline template not found', 404);
  }
  return rows;
}

async function listStaff({ firmId, db = pool }) {
  const { rows } = await db.query(`
    SELECT id, COALESCE(NULLIF(display_name,''), NULLIF(name,''), email) AS name, role
    FROM firm_users
    WHERE firm_id = $1 AND accepted_at IS NOT NULL AND archived_at IS NULL
    ORDER BY name ASC, id ASC`, [firmId]);
  return rows;
}

async function getMyWork({ firmId, staffUserId, db = pool }) {
  const staffId = positiveId(staffUserId, 'staff_user_id');
  const [jobs, tasks] = await Promise.all([
    listPipelineJobs({ firmId, assignedTo: staffId, includeCompleted: false, limit: 200, db }),
    db.query(`SELECT m.id AS message_id,
        LEFT(REGEXP_REPLACE(COALESCE(m.body,''), '^📋\\s*', ''), 200) AS title,
        m.created_at, mt.id AS thread_id, mt.person_id,
        NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS person_name
      FROM messages m
      JOIN message_threads mt ON mt.id = m.thread_id AND mt.firm_id = $1
      JOIN people p ON p.id = mt.person_id AND p.firm_id = mt.firm_id
      LEFT JOIN thread_dismissals td ON td.thread_id = mt.id AND td.firm_user_id = $2
      WHERE mt.staff_user_id = $2 AND m.message_type = 'task'
        AND mt.status NOT IN ('resolved','archived') AND td.id IS NULL
      ORDER BY m.created_at DESC LIMIT 200`, [firmId, staffId]),
  ]);
  const items = [
    ...jobs.map(job => ({ kind: 'pipeline_job', ...job })),
    ...tasks.rows.map(row => ({
      kind: 'task', id: row.message_id, thread_id: row.thread_id,
      title: row.title || 'Task',
      entity: { type: 'person', id: row.person_id, name: row.person_name || 'Unknown' },
      priority: 'normal', due_date: null, created_at: row.created_at,
    })),
  ];
  const today = new Date().toISOString().slice(0, 10);
  const overdue = items.filter(item => item.due_date && String(item.due_date).slice(0, 10) < today).length;
  return { items, counts: { overdue, total: items.length } };
}

function cleanDueDate(value) {
  if (value === null || value === '') return null;
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new AgentPipelineError('due_date must be YYYY-MM-DD or null');
  }
  return text;
}

async function updatePipelineJob({ firmId, jobId, input, db = pool }) {
  const id = positiveId(jobId, 'job_id');
  const fields = {};
  if (input.notes !== undefined) {
    fields.notes = String(input.notes ?? '').trim();
    if (fields.notes.length > 5000) throw new AgentPipelineError('notes must be 5000 characters or fewer');
  }
  if (input.priority !== undefined) {
    if (!['normal', 'high', 'urgent'].includes(input.priority)) throw new AgentPipelineError('priority must be normal, high, or urgent');
    fields.priority = input.priority;
  }
  if (input.due_date !== undefined) fields.due_date = cleanDueDate(input.due_date);
  if (input.job_status !== undefined) {
    if (!['active', 'blocked', 'complete', 'completed', 'archived'].includes(input.job_status)) {
      throw new AgentPipelineError('job_status is not supported');
    }
    fields.job_status = input.job_status;
  }
  if (input.assigned_to !== undefined) {
    fields.assigned_to = input.assigned_to === null ? null : positiveId(input.assigned_to, 'assigned_to');
    if (fields.assigned_to) {
      const staff = await db.query('SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2 AND accepted_at IS NOT NULL AND archived_at IS NULL', [fields.assigned_to, firmId]);
      if (!staff.rows[0]) throw new AgentPipelineError('Assigned staff member not found', 404);
    }
  }
  const entries = Object.entries(fields);
  if (!entries.length) throw new AgentPipelineError('No supported pipeline job fields supplied');
  const params = entries.map(([, value]) => value);
  const sets = entries.map(([field], index) => `${field} = $${index + 1}`);
  params.push(id, firmId);
  const result = await db.query(`UPDATE pipeline_jobs pj SET ${sets.join(', ')}, updated_at = NOW()
    FROM pipeline_instances pi
    WHERE pj.instance_id = pi.id AND pj.id = $${params.length - 1} AND pi.firm_id = $${params.length}
    RETURNING pj.id`, params);
  if (!result.rows[0]) throw new AgentPipelineError('Pipeline job not found', 404);
  return getPipelineJob({ firmId, jobId: id, db });
}

async function movePipelineJob({ firmId, staffUserId, jobId, stageId, note = '', db = pool, runActions = executeStageActions }) {
  const id = positiveId(jobId, 'job_id');
  const targetStageId = positiveId(stageId, 'stage_id');
  const historyNote = String(note || '').trim();
  if (historyNote.length > 2000) throw new AgentPipelineError('note must be 2000 characters or fewer');
  const moverId = staffUserId ? positiveId(staffUserId, 'staff_user_id') : null;
  const tx = db.connect ? await db.connect() : db;
  let actionContext = null;
  try {
    await tx.query('BEGIN');
    const jobResult = await tx.query(`SELECT pj.id, pj.instance_id, pj.entity_type, pj.entity_id, pj.current_stage_id,
        pi.name AS instance_name, pi.tax_year, pi.template_id, pt.name AS template_name
      FROM pipeline_jobs pj
      JOIN pipeline_instances pi ON pi.id = pj.instance_id
      JOIN pipeline_templates pt ON pt.id = pi.template_id AND pt.firm_id = pi.firm_id
      WHERE pj.id = $1 AND pi.firm_id = $2 FOR UPDATE OF pj`, [id, firmId]);
    const job = jobResult.rows[0];
    if (!job) throw new AgentPipelineError('Pipeline job not found', 404);
    const stageResult = await tx.query(`SELECT ps.id, ps.name, ps.auto_assign_to, ps.is_terminal,
        COALESCE(ps.hold_for_migration, false) AS hold_for_migration
      FROM pipeline_stages ps JOIN pipeline_templates pt ON pt.id = ps.template_id
      WHERE ps.id = $1 AND ps.template_id = $2 AND pt.firm_id = $3`, [targetStageId, job.template_id, firmId]);
    const stage = stageResult.rows[0];
    if (!stage) throw new AgentPipelineError('Stage does not belong to this pipeline', 400);
    if (stage.auto_assign_to) {
      const assignee = await tx.query('SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2 AND archived_at IS NULL', [stage.auto_assign_to, firmId]);
      if (!assignee.rows[0]) stage.auto_assign_to = null;
    }
    await tx.query(`INSERT INTO pipeline_job_history (job_id, from_stage_id, to_stage_id, moved_by, note)
      VALUES ($1,$2,$3,$4,$5)`, [id, job.current_stage_id, targetStageId, moverId, historyNote]);
    const terminal = stage.is_terminal && !stage.hold_for_migration;
    await tx.query(`UPDATE pipeline_jobs SET current_stage_id = $1,
        assigned_to = COALESCE($2, assigned_to), job_status = CASE WHEN $3 THEN 'archived' ELSE job_status END,
        updated_at = NOW() WHERE id = $4`, [targetStageId, stage.auto_assign_to || null, terminal, id]);
    if (terminal && ['person', 'company'].includes(job.entity_type)) {
      const taxYear = /^\d{4}$/.test(String(job.tax_year || '')) ? Number(job.tax_year) : null;
      await tx.query(`INSERT INTO pipeline_completions
        (firm_id, entity_type, entity_id, pipeline_instance_id, stage_id, pipeline_name, tax_year, job_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [firmId, job.entity_type, job.entity_id, job.instance_id,
        targetStageId, job.instance_name || job.template_name, taxYear, id]);
    }
    await tx.query('COMMIT');
    actionContext = {
      stageId: targetStageId,
      instanceId: job.instance_id,
      entityType: job.entity_type,
      entityId: job.entity_id,
      context: {
        pipeline_name: job.instance_name || job.template_name,
        tax_year: job.tax_year || '',
        stage_name: stage.name,
        triggered_by_user_id: moverId,
        job_id: id,
      },
    };
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (tx !== db) tx.release();
  }
  if (actionContext && runActions) {
    await Promise.resolve(runActions(
      firmId,
      actionContext.stageId,
      actionContext.instanceId,
      actionContext.entityType,
      actionContext.entityId,
      actionContext.context
    )).catch(error => console.error('[agent-work] pipeline stage action failed after move:', error.message));
  }
  return getPipelineJob({ firmId, jobId: id, db });
}

module.exports = {
  AgentPipelineError, boundedLimit, jobDto,
  listPipelineJobs, getPipelineJob, listTemplateStages, listStaff, getMyWork,
  updatePipelineJob, movePipelineJob,
};
