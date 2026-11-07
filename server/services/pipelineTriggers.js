'use strict';

/**
 * pipelineTriggers.js
 * Core service for Smart Pipeline Stages.
 *
 * fireTrigger(firmId, triggerKey, personId, context)
 *   - Looks up all stage configs for this firm + triggerKey
 *   - For each config: finds the person's active pipeline_job in that pipeline
 *   - Moves the job to the configured target stage
 *   - Logs the move
 *   - Returns array of move results
 *
 * IMPORTANT: fireTrigger is non-blocking safe — callers should wrap in:
 *   fireTrigger(...).catch(e => console.error('[trigger] non-fatal:', e));
 */

const { pool } = require('../db');
const { executeStageActions } = require('./pipelineActions');
const { recordActivityEvent } = require('./activityLog');

async function isTerminalStage(stageId) {
  const { rows } = await pool.query(
    'SELECT is_terminal FROM pipeline_stages WHERE id = $1',
    [stageId]
  );
  return rows[0]?.is_terminal === true;
}

/**
 * @param {number} firmId
 * @param {string} triggerKey  e.g. 'tax_return_deployed'
 * @param {number} entityId    person_id (default) or company_id
 * @param {object} [context={}]  extra metadata stored in the log
 * @param {string} [entityType='person']  'person' or 'company'
 * @returns {Promise<Array<{pipeline: string, from_stage: string|null, to_stage: string}>>}
 */
async function fireTrigger(firmId, triggerKey, entityId, context = {}, entityType = 'person') {
  const personId = entityType === 'person' ? entityId : null;
  const companyId = entityType === 'company' ? entityId : null;
  const moved = [];

  // 1. Find all stage configs for this firm + trigger
  //    Only match pipelines whose template entity_type matches the fired entityType
  const { rows: configs } = await pool.query(
    `SELECT pst.id, pst.pipeline_instance_id, pst.stage_id,
            pi.name AS pipeline_name,
            ps.name AS stage_name,
            ps.is_terminal, ps.hold_for_migration,
            pt.entity_type AS template_entity_type
     FROM pipeline_stage_triggers pst
     JOIN pipeline_instances pi ON pi.id = pst.pipeline_instance_id
     JOIN pipeline_templates pt ON pt.id = pi.template_id
     JOIN pipeline_stages ps ON ps.id = pst.stage_id
     WHERE pst.firm_id = $1
       AND pst.trigger_key = $2
       AND pt.entity_type = $3`,
    [firmId, triggerKey, entityType]
  );

  if (!configs.length) return moved;

  for (const cfg of configs) {
    try {
      // 2. Find the entity's active pipeline_job in this pipeline instance
      const { rows: jobRows } = await pool.query(
        `SELECT pj.id, pj.current_stage_id, ps.name AS from_stage_name
         FROM pipeline_jobs pj
         LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
         WHERE pj.instance_id = $1
           AND pj.entity_type = $2
           AND pj.entity_id = $3
           AND pj.job_status NOT IN ('completed', 'archived')
         LIMIT 1`,
        [cfg.pipeline_instance_id, entityType, entityId]
      );

      let job = jobRows[0];

      // Auto-create a card if none exists for this person in this pipeline
      if (!job) {
        const { rows: newJobRows } = await pool.query(
          `INSERT INTO pipeline_jobs (instance_id, entity_type, entity_id, current_stage_id, job_status)
           VALUES ($1, $2, $3, $4, 'active')
           RETURNING id, current_stage_id`,
          [cfg.pipeline_instance_id, entityType, entityId, cfg.stage_id]
        );
        // Log the creation
        await pool.query(
          `INSERT INTO pipeline_job_history (job_id, from_stage_id, to_stage_id, moved_by, note)
           VALUES ($1, NULL, $2, NULL, $3)`,
          [newJobRows[0].id, cfg.stage_id, `Auto-created + placed: trigger "${triggerKey}"`]
        );
        await pool.query(
          `INSERT INTO pipeline_trigger_log
             (firm_id, trigger_key, person_id, pipeline_instance_id, from_stage_id, to_stage_id, job_id, context)
           VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)`,
          [firmId, triggerKey, entityType === 'person' ? entityId : null, cfg.pipeline_instance_id,
           cfg.stage_id, newJobRows[0].id, JSON.stringify({ ...context, entityType, entityId, created: true })]
        );
        recordActivityEvent({
          firmId,
          eventType: 'pipeline_trigger_fired',
          title: `Pipeline trigger fired: ${triggerKey}`,
          summary: `${triggerKey} created a card in ${cfg.pipeline_name} → ${cfg.stage_name}.`,
          personId: entityType === 'person' ? entityId : null,
          companyId: entityType === 'company' ? entityId : null,
          relationshipId: entityType === 'relationship' ? entityId : null,
          taxYear: context.tax_year || '',
          entityType,
          entityId,
          sourceTable: 'pipeline_trigger_log',
          sourceId: String(newJobRows[0].id),
          dedupeKey: `pipeline_trigger_fired:${triggerKey}:${cfg.pipeline_instance_id}:${newJobRows[0].id}:created`,
          metadata: {
            trigger_key: triggerKey,
            pipeline_instance_id: cfg.pipeline_instance_id,
            pipeline_name: cfg.pipeline_name,
            to_stage_id: cfg.stage_id,
            to_stage_name: cfg.stage_name,
            job_id: newJobRows[0].id,
            created: true,
            context,
          },
        });
        moved.push({
          pipeline: cfg.pipeline_name,
          from_stage: null,
          to_stage: cfg.stage_name,
          created: true,
        });
        continue; // skip the move logic below — already in the right stage
      }

      // Skip if already in the target stage
      if (job.current_stage_id === cfg.stage_id) continue;

      // 3. Move the job
      await pool.query(
        `UPDATE pipeline_jobs SET current_stage_id = $1, updated_at = NOW() WHERE id = $2`,
        [cfg.stage_id, job.id]
      );

      // 4. Log the history
      await pool.query(
        `INSERT INTO pipeline_job_history (job_id, from_stage_id, to_stage_id, moved_by, note)
         VALUES ($1, $2, $3, NULL, $4)`,
        [job.id, job.current_stage_id, cfg.stage_id, `Auto-moved: trigger "${triggerKey}"`]
      );

      // 5. Write to trigger log
      await pool.query(
        `INSERT INTO pipeline_trigger_log
           (firm_id, trigger_key, person_id, pipeline_instance_id, from_stage_id, to_stage_id, job_id, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [firmId, triggerKey, entityType === 'person' ? entityId : null, cfg.pipeline_instance_id,
         job.current_stage_id, cfg.stage_id, job.id, JSON.stringify({ ...context, entityType, entityId })]
      );
      recordActivityEvent({
        firmId,
        eventType: 'pipeline_trigger_fired',
        title: `Pipeline trigger fired: ${triggerKey}`,
        summary: `${triggerKey} moved ${cfg.pipeline_name} from ${job.from_stage_name || 'unknown'} to ${cfg.stage_name}.`,
        personId: entityType === 'person' ? entityId : null,
        companyId: entityType === 'company' ? entityId : null,
        relationshipId: entityType === 'relationship' ? entityId : null,
        taxYear: context.tax_year || '',
        entityType,
        entityId,
        sourceTable: 'pipeline_trigger_log',
        sourceId: String(job.id),
        dedupeKey: `pipeline_trigger_fired:${triggerKey}:${cfg.pipeline_instance_id}:${job.id}:${job.current_stage_id}:${cfg.stage_id}`,
        metadata: {
          trigger_key: triggerKey,
          pipeline_instance_id: cfg.pipeline_instance_id,
          pipeline_name: cfg.pipeline_name,
          from_stage_id: job.current_stage_id,
          from_stage_name: job.from_stage_name || null,
          to_stage_id: cfg.stage_id,
          to_stage_name: cfg.stage_name,
          job_id: job.id,
          context,
        },
      });

      // 6. Terminal stage check — archive job + record completion
      try {
        if ((cfg.is_terminal || (await isTerminalStage(cfg.stage_id))) && !cfg.hold_for_migration) {
          await pool.query(
            `UPDATE pipeline_jobs SET job_status = 'archived', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );
          const { rows: instInfo } = await pool.query(
            `SELECT pi.firm_id, pi.name AS instance_name, pi.tax_year,
                    pt.name AS template_name
             FROM pipeline_instances pi
             JOIN pipeline_templates pt ON pt.id = pi.template_id
             WHERE pi.id = $1`,
            [cfg.pipeline_instance_id]
          );
          const inst = instInfo[0];
          if (inst) {
            const taxYearInt = inst.tax_year ? parseInt(inst.tax_year) : null;
            await pool.query(
              `INSERT INTO pipeline_completions
                 (firm_id, entity_type, entity_id, pipeline_instance_id, stage_id, pipeline_name, tax_year, job_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [firmId, entityType, entityId, cfg.pipeline_instance_id, cfg.stage_id, cfg.pipeline_name || null, taxYearInt, job.id]
            );
          }
        }
      } catch (termErr) {
        console.error(`[pipelineTriggers] terminal check error (non-fatal):`, termErr);
      }

      // ── Fire pipeline stage actions (non-blocking) ──
      executeStageActions(
        firmId,
        cfg.stage_id,
        cfg.pipeline_instance_id,
        entityType,
        entityId,
        {
          pipeline_name: cfg.pipeline_name,
          tax_year: context.tax_year || '',
          stage_name: cfg.stage_name,
          triggered_by_user_id: context.triggered_by_user_id || null,
          job_id: job.id,
        }
      ).catch(e => console.error('[actions] non-fatal (trigger):', e));

      moved.push({
        pipeline: cfg.pipeline_name,
        from_stage: job.from_stage_name || null,
        to_stage: cfg.stage_name,
      });
    } catch (err) {
      console.error(`[pipelineTriggers] fireTrigger error for config ${cfg.id}:`, err);
    }
  }

  return moved;
}

module.exports = { fireTrigger };
