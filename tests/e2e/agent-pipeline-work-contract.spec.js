'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  boundedLimit,
  jobDto,
  getMyWork,
  listPipelineJobs,
  listTemplateStages,
  updatePipelineJob,
} = require('../../server/services/agentPipelineWork');

const root = path.join(__dirname, '..', '..');

test('pipeline job DTO is an explicit response allowlist', () => {
  const dto = jobDto({
    id: 1,
    instance_id: 2,
    entity_type: 'company',
    entity_id: 3,
    notes: 'bounded work note',
    internal_secret: 'never expose',
    auto_message: 'not part of the job contract',
  });
  assert.equal(dto.id, 1);
  assert.equal(dto.notes, 'bounded work note');
  assert.equal(dto.internal_secret, undefined);
  assert.equal(dto.auto_message, undefined);
});

test('pipeline job listing is firm-bound and limits results', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  await listPipelineJobs({ firmId: 42, assignedTo: 9, instanceId: 7, includeCompleted: false, limit: 500, db });
  assert.match(calls[0].sql, /pi\.firm_id = \$1/);
  assert.match(calls[0].sql, /pj\.assigned_to = \$2/);
  assert.match(calls[0].sql, /pj\.instance_id = \$3/);
  assert.deepEqual(calls[0].params, [42, 9, 7, 200]);
  assert.equal(boundedLimit(999), 200);
});

test('template stages require a template belonging to the firm', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [{ id: 4, template_id: 6, name: 'Review' }] }; } };
  const stages = await listTemplateStages({ firmId: 88, templateId: 6, db });
  assert.equal(stages.length, 1);
  assert.deepEqual(calls[0].params, [6, 88]);
  assert.match(calls[0].sql, /pt\.firm_id = \$2/);
});

test('my work is bound to the authenticated staff identity', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  const result = await getMyWork({ firmId: 42, staffUserId: 9, db });
  assert.deepEqual(result, { items: [], counts: { overdue: 0, total: 0 } });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /pi\.firm_id = \$1/);
  assert.deepEqual(calls[0].params, [42, 9, 200]);
  assert.match(calls[1].sql, /mt\.firm_id = \$1/);
  assert.match(calls[1].sql, /mt\.staff_user_id = \$2/);
  assert.deepEqual(calls[1].params, [42, 9]);
});

test('job updates accept only bounded fields and bind the update through a firm-owned instance', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE pipeline_jobs')) return { rows: [{ id: 5 }] };
      return { rows: [{ id: 5, instance_id: 3, job_status: 'active' }] };
    },
  };
  await updatePipelineJob({
    firmId: 77,
    jobId: 5,
    input: { priority: 'high', due_date: '2026-09-01', ignored_field: 'nope' },
    db,
  });
  assert.match(calls[0].sql, /UPDATE pipeline_jobs pj SET priority = \$1, due_date = \$2/);
  assert.match(calls[0].sql, /pi\.firm_id = \$4/);
  assert.deepEqual(calls[0].params, ['high', '2026-09-01', 5, 77]);
  assert.doesNotMatch(calls[0].sql, /ignored_field/);
});

test('mountable routers use separate read/write capabilities and expose no deletes', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/agent-work-pipelines.js'), 'utf8');
  assert.match(source, /requireCapability\('pipelines_read'\)/);
  assert.match(source, /requireCapability\('pipelines_write'\)/);
  assert.match(source, /requireCapability\('staff_read'\)/);
  assert.match(source, /requireCapability\('work_read'\)/);
  assert.doesNotMatch(source, /router\.delete\(/);
  assert.match(source, /router\.get\('\/jobs'/);
  assert.match(source, /router\.put\('\/jobs\/:jobId'/);
  assert.match(source, /router\.post\('\/jobs\/:jobId\/move'/);
  assert.match(source, /router\.get\('\/templates\/:templateId\/stages'/);
});
