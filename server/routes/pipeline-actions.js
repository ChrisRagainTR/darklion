'use strict';

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

// Helper: verify action belongs to this firm
async function getAction(firmId, actionId) {
  const { rows } = await pool.query(
    'SELECT * FROM pipeline_stage_actions WHERE id = $1 AND firm_id = $2',
    [actionId, firmId]
  );
  return rows[0] || null;
}

// ── GET /api/pipeline-actions/:pipelineInstanceId
// Returns all actions for a pipeline, grouped by stage_id
router.get('/:pipelineInstanceId', async (req, res) => {
  try {
    const firmId = req.firm.id;
    const instanceId = parseInt(req.params.pipelineInstanceId);

    // Verify instance belongs to firm
    const { rows: instRows } = await pool.query(
      'SELECT id FROM pipeline_instances WHERE id = $1 AND firm_id = $2',
      [instanceId, firmId]
    );
    if (!instRows[0]) return res.status(404).json({ error: 'Pipeline instance not found' });

    const { rows: actions } = await pool.query(
      `SELECT * FROM pipeline_stage_actions
       WHERE firm_id = $1 AND pipeline_instance_id = $2
       ORDER BY stage_id, position ASC, id ASC`,
      [firmId, instanceId]
    );

    // Group by stage_id
    const grouped = {};
    for (const action of actions) {
      if (!grouped[action.stage_id]) grouped[action.stage_id] = [];
      grouped[action.stage_id].push(action);
    }

    res.json(grouped);
  } catch (e) {
    console.error('GET /pipeline-actions/:instanceId error:', e);
    res.status(500).json({ error: 'Failed to load actions' });
  }
});

// ── POST /api/pipeline-actions
// Create an action
router.post('/', async (req, res) => {
  try {
    const firmId = req.firm.id;
    const { pipeline_instance_id, stage_id, action_type, config = {} } = req.body;

    if (!pipeline_instance_id || !stage_id || !action_type) {
      return res.status(400).json({ error: 'pipeline_instance_id, stage_id, and action_type are required' });
    }

    if (!['portal_message', 'staff_task'].includes(action_type)) {
      return res.status(400).json({ error: 'action_type must be portal_message or staff_task' });
    }

    // Verify instance belongs to firm
    const { rows: instRows } = await pool.query(
      'SELECT id, template_id FROM pipeline_instances WHERE id = $1 AND firm_id = $2',
      [parseInt(pipeline_instance_id), firmId]
    );
    if (!instRows[0]) return res.status(404).json({ error: 'Pipeline instance not found' });

    // Verify stage belongs to this pipeline's template
    const { rows: stageRows } = await pool.query(
      'SELECT id FROM pipeline_stages WHERE id = $1 AND template_id = $2',
      [parseInt(stage_id), instRows[0].template_id]
    );
    if (!stageRows[0]) return res.status(400).json({ error: 'Stage does not belong to this pipeline' });

    // Get max position for this stage
    const { rows: posRows } = await pool.query(
      `SELECT COALESCE(MAX(position), -1) AS max_pos
       FROM pipeline_stage_actions
       WHERE firm_id = $1 AND pipeline_instance_id = $2 AND stage_id = $3`,
      [firmId, parseInt(pipeline_instance_id), parseInt(stage_id)]
    );
    const position = (posRows[0]?.max_pos ?? -1) + 1;

    const { rows } = await pool.query(
      `INSERT INTO pipeline_stage_actions
         (firm_id, pipeline_instance_id, stage_id, action_type, config, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [firmId, parseInt(pipeline_instance_id), parseInt(stage_id), action_type, JSON.stringify(config), position]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /pipeline-actions error:', e);
    res.status(500).json({ error: 'Failed to create action' });
  }
});

// ── PUT /api/pipeline-actions/:id
// Update action config
router.put('/:id', async (req, res) => {
  try {
    const firmId = req.firm.id;
    const action = await getAction(firmId, parseInt(req.params.id));
    if (!action) return res.status(404).json({ error: 'Action not found' });

    const config = req.body.config !== undefined ? req.body.config : action.config;
    const position = req.body.position !== undefined ? req.body.position : action.position;

    const { rows } = await pool.query(
      `UPDATE pipeline_stage_actions SET config = $1, position = $2 WHERE id = $3 RETURNING *`,
      [JSON.stringify(config), position, action.id]
    );

    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /pipeline-actions/:id error:', e);
    res.status(500).json({ error: 'Failed to update action' });
  }
});

// ── DELETE /api/pipeline-actions/:id
// Remove action
router.delete('/:id', async (req, res) => {
  try {
    const firmId = req.firm.id;
    const action = await getAction(firmId, parseInt(req.params.id));
    if (!action) return res.status(404).json({ error: 'Action not found' });

    await pool.query('DELETE FROM pipeline_stage_actions WHERE id = $1', [action.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /pipeline-actions/:id error:', e);
    res.status(500).json({ error: 'Failed to delete action' });
  }
});

module.exports = router;
