'use strict';

const { pool } = require('../db');
const { decrypt } = require('../utils/encryption');

async function getFirmContext(firmId) {
  const [
    pipelineJobs,
    unsignedReturns,
    stalledMessages,
    openProposals,
    noPipeline,
    expiringEngagements,
    relationshipSummary,
    recentActivity,
    birthdaysRaw,
  ] = await Promise.all([
    pool.query(`
      SELECT pj.id, pj.job_status AS status, pj.entity_type, pj.entity_id,
             pj.current_stage_id, ps.name as stage_name, ps.position as stage_position,
             pt.name as template_name,
             c.company_name, p.first_name || ' ' || p.last_name as person_name,
             r.name as relationship_name, r.id as relationship_id,
             pj.updated_at
      FROM pipeline_jobs pj
      JOIN pipeline_instances pi ON pi.id = pj.instance_id
      JOIN pipeline_templates pt ON pt.id = pi.template_id
      LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
      LEFT JOIN companies c ON c.id = pj.entity_id AND pj.entity_type = 'company'
      LEFT JOIN people p ON p.id = pj.entity_id AND pj.entity_type = 'person'
      LEFT JOIN relationships r ON r.id = COALESCE(c.relationship_id, p.relationship_id)
      WHERE pi.firm_id = $1 AND pj.job_status NOT IN ('complete', 'archived')
      ORDER BY ps.position ASC, pj.updated_at DESC
      LIMIT 100
    `, [firmId]).catch(() => ({ rows: [] })),

    pool.query(`
      SELECT td.id, td.tax_year, td.status,
             co.company_name, p.first_name || ' ' || p.last_name as person_name,
             r.name as relationship_name, r.id as relationship_id,
             EXTRACT(DAY FROM NOW() - td.updated_at)::INT as days_waiting
      FROM tax_deliveries td
      LEFT JOIN companies co ON co.id = td.company_id
      LEFT JOIN relationships r ON r.id = co.relationship_id
      LEFT JOIN people p ON p.id = (SELECT person_id FROM tax_delivery_signers WHERE delivery_id = td.id LIMIT 1)
      WHERE td.firm_id = $1 AND td.status IN ('sent','approved')
        AND NOT EXISTS (SELECT 1 FROM tax_delivery_signers tds WHERE tds.delivery_id = td.id AND tds.signed_at IS NOT NULL)
      ORDER BY td.updated_at ASC LIMIT 20
    `, [firmId]).catch(() => ({ rows: [] })),

    pool.query(`
      SELECT mt.id, mt.subject, mt.last_message_at, mt.status,
             p.first_name, p.last_name, p.spouse_name,
             p.first_name || ' ' || p.last_name as person_name,
             p.id as person_id,
             r.name as relationship_name, r.id as relationship_id,
             EXTRACT(DAY FROM NOW() - mt.last_message_at)::INT as days_since,
             (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) as unread_count
      FROM message_threads mt
      LEFT JOIN people p ON p.id = mt.person_id
      LEFT JOIN relationships r ON r.id = p.relationship_id
      WHERE mt.firm_id = $1 AND mt.status = 'open'
        AND mt.last_message_at < NOW() - INTERVAL '48 hours'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client')
      ORDER BY mt.last_message_at ASC LIMIT 20
    `, [firmId]).catch(() => ({ rows: [] })),

    pool.query(`
      SELECT id, client_name, client_email, title, engagement_type, status,
             EXTRACT(DAY FROM NOW() - created_at)::INT as days_old,
             created_at, viewed_at
      FROM proposals
      WHERE firm_id = $1 AND status IN ('sent','viewed')
      ORDER BY created_at ASC LIMIT 20
    `, [firmId]).catch(() => ({ rows: [] })),

    pool.query(`
      SELECT r.id, r.name, r.created_at,
             EXTRACT(DAY FROM NOW() - r.created_at)::INT as days_old
      FROM relationships r
      WHERE r.firm_id = $1
        AND r.created_at > NOW() - INTERVAL '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_jobs pj
          JOIN pipeline_instances pi ON pi.id = pj.instance_id
          WHERE pi.firm_id = $1 AND (
            EXISTS (SELECT 1 FROM companies c WHERE c.relationship_id = r.id AND c.id = pj.entity_id AND pj.entity_type = 'company')
            OR EXISTS (SELECT 1 FROM people pe WHERE pe.relationship_id = r.id AND pe.id = pj.entity_id AND pj.entity_type = 'person')
          )
        )
      ORDER BY r.created_at DESC LIMIT 20
    `, [firmId]).catch(() => ({ rows: [] })),

    pool.query(`
      SELECT el.id, el.display_name,
             r.id as relationship_id, r.name as relationship_name,
             (el.extracted_data->>'term_end_date') as term_end_date
      FROM engagement_letters el
      JOIN relationships r ON r.id = el.relationship_id
      WHERE el.firm_id = $1
        AND el.status = 'active'
        AND el.extracted_data->>'term_end_date' IS NOT NULL
        AND (el.extracted_data->>'term_end_date')::DATE BETWEEN NOW() AND NOW() + INTERVAL '60 days'
      ORDER BY (el.extracted_data->>'term_end_date')::DATE ASC LIMIT 10
    `, [firmId]).catch(() => ({ rows: [] })),

    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM relationships WHERE firm_id = $1) as total_relationships,
        (SELECT COUNT(*) FROM people WHERE firm_id = $1) as total_people,
        (SELECT COUNT(*) FROM companies WHERE firm_id = $1) as total_companies,
        (SELECT COUNT(*) FROM message_threads WHERE firm_id = $1 AND status = 'open') as open_threads,
        (SELECT COUNT(*) FROM proposals WHERE firm_id = $1 AND status NOT IN ('draft','signed')) as active_proposals,
        (SELECT COALESCE(SUM(monthly_price),0) FROM proposal_engagements WHERE firm_id = $1 AND status = 'signed') as signed_mrr
    `, [firmId]).catch(() => ({ rows: [{}] })),

    pool.query(`
      SELECT 'tax_delivery' as type, td.id, td.tax_year as detail,
             co.company_name as entity_name, td.status, td.updated_at
      FROM tax_deliveries td
      LEFT JOIN companies co ON co.id = td.company_id
      WHERE td.firm_id = $1 AND td.updated_at > NOW() - INTERVAL '7 days'
      ORDER BY td.updated_at DESC LIMIT 10
    `, [firmId]).catch(() => ({ rows: [] })),

    pool.query(`
      SELECT p.id, p.first_name, p.last_name, p.date_of_birth_encrypted,
             r.name as relationship_name
      FROM people p
      LEFT JOIN relationships r ON r.id = p.relationship_id
      WHERE p.firm_id = $1 AND p.date_of_birth_encrypted IS NOT NULL LIMIT 500
    `, [firmId]).catch(() => ({ rows: [] })),
  ]);

  // Process birthdays
  const currentMonth = new Date().getMonth() + 1;
  const currentDay = new Date().getDate();
  const birthdays = [];
  for (const person of birthdaysRaw.rows) {
    try {
      const dob = decrypt(person.date_of_birth_encrypted);
      if (!dob) continue;
      const d = new Date(dob);
      if (d.getMonth() + 1 === currentMonth) {
        birthdays.push({
          id: person.id,
          name: `${person.first_name} ${person.last_name}`.trim(),
          relationship_name: person.relationship_name,
          birthday_day: d.getDate(),
          is_today: d.getDate() === currentDay,
        });
      }
    } catch(e) { /* skip */ }
  }
  birthdays.sort((a, b) => a.birthday_day - b.birthday_day);

  const pipelineByStage = {};
  for (const job of pipelineJobs.rows) {
    const stageName = job.stage_name || 'Unknown Stage';
    if (!pipelineByStage[stageName]) pipelineByStage[stageName] = [];
    pipelineByStage[stageName].push(job);
  }

  return {
    generated_at: new Date().toISOString(),
    firm_summary: relationshipSummary.rows[0] || {},
    pipeline: { by_stage: pipelineByStage, total_active: pipelineJobs.rows.length },
    urgent: {
      unsigned_tax_returns: unsignedReturns.rows,
      stalled_messages: stalledMessages.rows,
      open_proposals: openProposals.rows,
    },
    needs_attention: {
      new_clients_no_pipeline: noPipeline.rows,
      expiring_engagements: expiringEngagements.rows,
      birthdays_this_month: birthdays,
    },
    recent_activity: recentActivity.rows,
  };
}

module.exports = { getFirmContext };
