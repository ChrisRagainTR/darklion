'use strict';

/**
 * pipeline-triggers.js
 * Smart Pipeline Stages — API routes
 *
 * Mounted at: /api/pipeline-triggers
 * All routes require requireFirm middleware (already applied in index.js)
 */

const { Router } = require('express');
const { pool } = require('../db');
const { fireTrigger } = require('../services/pipelineTriggers');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pipeline-triggers
// List all available trigger types (from pipeline_triggers table)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, key, label, category FROM pipeline_triggers ORDER BY category, label'
    );
    res.json(rows);
  } catch (e) {
    console.error('[pipeline-triggers] GET / error:', e);
    res.status(500).json({ error: 'Failed to load triggers' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pipeline-triggers/stage-config/:pipelineInstanceId
// Get all smart stage configs for a pipeline instance
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stage-config/:pipelineInstanceId', async (req, res) => {
  const firmId = req.firm.id;
  const instanceId = parseInt(req.params.pipelineInstanceId);

  try {
    // Verify instance belongs to firm
    const { rows: inst } = await pool.query(
      'SELECT id FROM pipeline_instances WHERE id = $1 AND firm_id = $2',
      [instanceId, firmId]
    );
    if (!inst[0]) return res.status(404).json({ error: 'Instance not found' });

    const { rows } = await pool.query(
      `SELECT pst.id, pst.stage_id, pst.trigger_key,
              ps.name AS stage_name,
              pt.label AS trigger_label, pt.category AS trigger_category
       FROM pipeline_stage_triggers pst
       JOIN pipeline_stages ps ON ps.id = pst.stage_id
       JOIN pipeline_triggers pt ON pt.key = pst.trigger_key
       WHERE pst.firm_id = $1 AND pst.pipeline_instance_id = $2
       ORDER BY ps.position ASC`,
      [firmId, instanceId]
    );
    res.json(rows);
  } catch (e) {
    console.error('[pipeline-triggers] GET /stage-config/:id error:', e);
    res.status(500).json({ error: 'Failed to load stage configs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pipeline-triggers/stage-config
// Save/update a trigger→stage mapping for a pipeline
// Body: { pipeline_instance_id, stage_id, trigger_key }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/stage-config', async (req, res) => {
  const firmId = req.firm.id;
  const { pipeline_instance_id, stage_id, trigger_key } = req.body;

  if (!pipeline_instance_id || !stage_id || !trigger_key) {
    return res.status(400).json({ error: 'pipeline_instance_id, stage_id, and trigger_key are required' });
  }

  try {
    // Verify instance belongs to firm
    const { rows: inst } = await pool.query(
      'SELECT id, template_id FROM pipeline_instances WHERE id = $1 AND firm_id = $2',
      [pipeline_instance_id, firmId]
    );
    if (!inst[0]) return res.status(404).json({ error: 'Instance not found' });

    // Verify trigger_key exists
    const { rows: trig } = await pool.query(
      'SELECT key FROM pipeline_triggers WHERE key = $1',
      [trigger_key]
    );
    if (!trig[0]) return res.status(400).json({ error: 'Unknown trigger_key' });

    // Verify stage belongs to this pipeline's template
    const { rows: stageCheck } = await pool.query(
      'SELECT id FROM pipeline_stages WHERE id = $1 AND template_id = $2',
      [stage_id, inst[0].template_id]
    );
    if (!stageCheck[0]) return res.status(400).json({ error: 'Stage does not belong to this pipeline' });

    // Enforce max 2 triggers per stage
    const { rows: existingForStage } = await pool.query(
      'SELECT id FROM pipeline_stage_triggers WHERE firm_id = $1 AND pipeline_instance_id = $2 AND stage_id = $3',
      [firmId, pipeline_instance_id, stage_id]
    );
    if (existingForStage.length >= 2) {
      return res.status(400).json({ error: 'Maximum of 2 triggers per stage. Remove one before adding another.' });
    }

    // Upsert: one trigger = one destination per pipeline (UNIQUE on firm_id, pipeline_instance_id, trigger_key)
    const { rows } = await pool.query(
      `INSERT INTO pipeline_stage_triggers (firm_id, pipeline_instance_id, stage_id, trigger_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (firm_id, pipeline_instance_id, trigger_key)
       DO UPDATE SET stage_id = EXCLUDED.stage_id
       RETURNING *`,
      [firmId, pipeline_instance_id, stage_id, trigger_key]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[pipeline-triggers] POST /stage-config error:', e);
    res.status(500).json({ error: 'Failed to save stage config' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/pipeline-triggers/stage-config/:id
// Remove a trigger→stage mapping
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/stage-config/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      'DELETE FROM pipeline_stage_triggers WHERE id = $1 AND firm_id = $2 RETURNING id',
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Config not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[pipeline-triggers] DELETE /stage-config/:id error:', e);
    res.status(500).json({ error: 'Failed to delete stage config' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pipeline-triggers/fire
// Fire a trigger — moves pipeline cards, logs everything
// Body: { trigger_key, person_id, context: {} }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/fire', async (req, res) => {
  const firmId = req.firm.id;
  const { trigger_key, person_id, context = {} } = req.body;

  if (!trigger_key || !person_id) {
    return res.status(400).json({ error: 'trigger_key and person_id are required' });
  }

  try {
    // Verify person belongs to firm
    const { rows: personCheck } = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [person_id, firmId]
    );
    if (!personCheck[0]) return res.status(404).json({ error: 'Person not found' });

    // Verify trigger_key exists
    const { rows: trig } = await pool.query(
      'SELECT key, label FROM pipeline_triggers WHERE key = $1',
      [trigger_key]
    );
    if (!trig[0]) return res.status(400).json({ error: 'Unknown trigger_key' });

    const moved = await fireTrigger(firmId, trigger_key, person_id, {
      ...context,
      fired_by: req.firm.userId || null,
      manual: true,
    });

    res.json({ ok: true, moved });
  } catch (e) {
    console.error('[pipeline-triggers] POST /fire error:', e);
    res.status(500).json({ error: 'Failed to fire trigger' });
  }
});

module.exports = router;
