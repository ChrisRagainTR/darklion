'use strict';

const { Router } = require('express');
const pipelines = require('../services/agentPipelineWork');

function createAgentWorkPipelinesRouter({ requireCapability, audit }) {
  const router = Router();

  function route(handler, eventType) {
    return async (req, res) => {
      try {
        const result = await handler(req);
        await audit(req, eventType, {
          job_id: req.params.jobId ? Number(req.params.jobId) : undefined,
          template_id: req.params.templateId ? Number(req.params.templateId) : undefined,
          count: Array.isArray(result) ? result.length : undefined,
        }).catch(() => {});
        res.json(result);
      } catch (error) {
        const status = error.statusCode || 500;
        if (status >= 500) console.error('[agent-work] pipeline operation error:', error);
        res.status(status).json({ error: status >= 500 ? 'Pipeline operation failed' : error.message });
      }
    };
  }

  const read = requireCapability('pipelines_read');
  const write = requireCapability('pipelines_write');

  router.get('/jobs', read, route(req => pipelines.listPipelineJobs({
    firmId: req.agentFirmId,
    assignedTo: req.query.assigned_to,
    instanceId: req.query.instance_id,
    includeCompleted: req.query.include_completed === 'true',
    limit: req.query.limit,
  }), 'pipeline_jobs_listed'));

  router.put('/jobs/:jobId', write, route(req => pipelines.updatePipelineJob({
    firmId: req.agentFirmId,
    jobId: req.params.jobId,
    input: req.body || {},
  }), 'pipeline_job_updated'));

  router.post('/jobs/:jobId/move', write, route(req => pipelines.movePipelineJob({
    firmId: req.agentFirmId,
    staffUserId: req.agentStaffUserId,
    jobId: req.params.jobId,
    stageId: req.body?.stage_id,
    note: req.body?.note,
  }), 'pipeline_job_moved'));

  router.get('/templates/:templateId/stages', read, route(req => pipelines.listTemplateStages({
    firmId: req.agentFirmId,
    templateId: req.params.templateId,
  }), 'pipeline_template_stages_listed'));

  return router;
}

function createAgentWorkStaffRouter({ requireCapability, audit }) {
  const router = Router();
  router.get('/', requireCapability('staff_read'), async (req, res) => {
    try {
      const staff = await pipelines.listStaff({ firmId: req.agentFirmId });
      await audit(req, 'staff_listed', { count: staff.length }).catch(() => {});
      res.json(staff);
    } catch (error) {
      console.error('[agent-work] staff list error:', error);
      res.status(500).json({ error: 'Failed to list staff' });
    }
  });
  return router;
}

function createAgentWorkMyWorkRouter({ requireCapability, audit }) {
  const router = Router();
  router.get('/', requireCapability('work_read'), async (req, res) => {
    try {
      const result = await pipelines.getMyWork({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId });
      await audit(req, 'my_work_read', { count: result.counts.total, overdue: result.counts.overdue }).catch(() => {});
      res.json(result);
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) console.error('[agent-work] my work error:', error);
      res.status(status).json({ error: status >= 500 ? 'Failed to load assigned work' : error.message });
    }
  });
  return router;
}

module.exports = { createAgentWorkPipelinesRouter, createAgentWorkStaffRouter, createAgentWorkMyWorkRouter };
