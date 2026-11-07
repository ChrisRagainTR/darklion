'use strict';

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

async function loadPipelineJobs(firmId, userId) {
  const { rows } = await pool.query(
    `SELECT
       pj.id,
       pj.entity_type,
       pj.entity_id,
       pj.priority,
       pj.due_date,
       pj.created_at,
       pj.updated_at,
       ps.name AS stage_name,
       pi.name AS pipeline_name,
       pi.tax_year AS pipeline_tax_year,
       CASE pj.entity_type
         WHEN 'company'      THEN c.company_name
         WHEN 'person'       THEN TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,''))
         WHEN 'relationship' THEN r.name
       END AS entity_name
     FROM pipeline_jobs pj
     JOIN pipeline_instances pi ON pi.id = pj.instance_id
     LEFT JOIN pipeline_stages ps  ON ps.id = pj.current_stage_id
     LEFT JOIN companies c         ON pj.entity_type = 'company'      AND c.id = pj.entity_id
     LEFT JOIN people p            ON pj.entity_type = 'person'       AND p.id = pj.entity_id
     LEFT JOIN relationships r     ON pj.entity_type = 'relationship' AND r.id = pj.entity_id
     WHERE pi.firm_id = $1
       AND pj.assigned_to = $2
       AND COALESCE(pj.job_status, 'active') = 'active'`,
    [firmId, userId]
  );
  return rows;
}

async function loadTaskMessages(firmId, userId) {
  const { rows } = await pool.query(
    `SELECT
       m.id          AS message_id,
       m.body,
       m.created_at,
       mt.id         AS thread_id,
       mt.subject,
       mt.person_id,
       p.first_name,
       p.last_name
     FROM messages m
     JOIN message_threads mt ON mt.id = m.thread_id
     JOIN people p           ON p.id = mt.person_id
     LEFT JOIN thread_dismissals td
            ON td.thread_id = mt.id AND td.firm_user_id = $2
     WHERE mt.firm_id = $1
       AND mt.staff_user_id = $2
       AND m.message_type = 'task'
       AND mt.status NOT IN ('resolved', 'archived')
       AND td.id IS NULL`,
    [firmId, userId]
  );
  return rows;
}

// Strip the markdown link bookkeeping from an auto-generated task body.
//   "📋 Send organizer — Acme Corp\n\n[View Acme Corp →](/crm/company/12)"
// → "Send organizer — Acme Corp"
function extractTaskTitle(body) {
  if (!body) return 'Task';
  const firstLine = body.split('\n')[0].trim();
  return firstLine.replace(/^📋\s*/, '').slice(0, 200) || 'Task';
}

function entityLink(entityType, entityId) {
  if (entityType === 'company')      return `/crm/company/${entityId}`;
  if (entityType === 'person')       return `/crm/person/${entityId}`;
  if (entityType === 'relationship') return `/crm/relationship/${entityId}`;
  return '/dashboard';
}

function buildItems(jobs, tasks) {
  const items = [];

  for (const j of jobs) {
    items.push({
      kind: 'pipeline_job',
      id: j.id,
      title: j.stage_name || 'Pipeline job',
      entity: { type: j.entity_type, id: j.entity_id, name: j.entity_name || `#${j.entity_id}` },
      pipelineName: j.pipeline_name,
      pipelineTaxYear: j.pipeline_tax_year || '',
      stageName: j.stage_name,
      priority: j.priority || 'normal',
      dueDate: j.due_date ? new Date(j.due_date).toISOString().slice(0, 10) : null,
      createdAt: j.created_at,
      link: entityLink(j.entity_type, j.entity_id),
    });
  }

  for (const t of tasks) {
    const personName = `${t.first_name || ''} ${t.last_name || ''}`.trim() || 'Unknown';
    items.push({
      kind: 'task',
      id: t.message_id,
      threadId: t.thread_id,
      title: extractTaskTitle(t.body),
      entity: { type: 'person', id: t.person_id, name: personName },
      pipelineName: null,
      pipelineTaxYear: '',
      stageName: null,
      priority: 'normal',
      dueDate: null,
      createdAt: t.created_at,
      link: `/messages?thread=${t.thread_id}`,
    });
  }

  return items;
}

function isOverdue(item, today) {
  if (!item.dueDate) return false;
  return item.dueDate < today;
}

// ── GET /api/my-work — full list for the dashboard ─────────────────────────
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  if (!userId) return res.json({ items: [], counts: { overdue: 0, total: 0 } });

  try {
    const [jobs, tasks] = await Promise.all([
      loadPipelineJobs(firmId, userId),
      loadTaskMessages(firmId, userId),
    ]);

    const items = buildItems(jobs, tasks);
    const today = new Date().toISOString().slice(0, 10);

    // Sort: overdue first, then by due date (asc, nulls last), then priority desc, then age desc
    const priorityRank = { urgent: 3, high: 2, normal: 1 };
    items.sort((a, b) => {
      const aOver = isOverdue(a, today) ? 0 : 1;
      const bOver = isOverdue(b, today) ? 0 : 1;
      if (aOver !== bOver) return aOver - bOver;
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;
      const pr = (priorityRank[b.priority] || 0) - (priorityRank[a.priority] || 0);
      if (pr !== 0) return pr;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    const overdue = items.filter(i => isOverdue(i, today)).length;
    res.json({ items, counts: { overdue, total: items.length } });
  } catch (err) {
    console.error('[GET /api/my-work] error:', err);
    res.status(500).json({ error: 'Failed to load my work' });
  }
});

// ── GET /api/my-work/count — lightweight badge ─────────────────────────────
router.get('/count', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  if (!userId) return res.json({ overdue: 0, total: 0 });

  try {
    const [jobs, tasks] = await Promise.all([
      loadPipelineJobs(firmId, userId),
      loadTaskMessages(firmId, userId),
    ]);
    const items = buildItems(jobs, tasks);
    const today = new Date().toISOString().slice(0, 10);
    const overdue = items.filter(i => isOverdue(i, today)).length;
    res.json({ overdue, total: items.length });
  } catch (err) {
    console.error('[GET /api/my-work/count] error:', err);
    res.status(500).json({ overdue: 0, total: 0 });
  }
});

module.exports = router;
