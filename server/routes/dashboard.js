const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { decrypt } = require('../utils/encryption');

// GET /api/dashboard/intel — all intelligence data for the dashboard
router.get('/intel', async (req, res) => {
  const firmId = req.firm.id;

  try {
    const [
      // Unsigned tax returns (sent but not signed)
      unsignedReturns,
      // Messages needing reply (open threads with no staff reply in 48h)
      stalledMessages,
      // Unsigned proposals (sent/viewed, not accepted)
      openProposals,
      // MRR from signed engagements
      mrrData,
      // Portal-inactive clients (portal enabled, no login in 60+ days)
      portalInactive,
      // Engagements expiring in next 60 days
      expiringEngagements,
      // Birthdays this month
      birthdaysThisMonth,
      // New relationships with no pipeline job (created in last 30 days)
      noPipeline,
      // CRM counts
      counts,
      // Monthly proposal activity (last 6 months for chart)
      proposalActivity,
    ] = await Promise.all([

      // 1. Unsigned tax returns
      pool.query(`
        SELECT td.id, td.tax_year, td.title, td.created_at, td.status,
               c.company_name, c.id AS company_id,
               r.name AS relationship_name, r.id AS relationship_id,
               EXTRACT(DAY FROM NOW() - td.updated_at)::INT AS days_waiting,
               signer.first_name || ' ' || signer.last_name AS person_name,
               signer.id AS person_id,
               signer.relationship_id AS person_relationship_id
        FROM tax_deliveries td
        LEFT JOIN companies c ON c.id = td.company_id
        LEFT JOIN relationships r ON r.id = (
          SELECT relationship_id FROM companies WHERE id = td.company_id LIMIT 1
        )
        LEFT JOIN LATERAL (
          SELECT p2.id, p2.first_name, p2.last_name, p2.relationship_id
          FROM tax_delivery_signers tds2
          JOIN people p2 ON p2.id = tds2.person_id
          WHERE tds2.delivery_id = td.id LIMIT 1
        ) signer ON true
        WHERE td.firm_id = $1
          AND td.status IN ('sent','approved')
          AND NOT EXISTS (
            SELECT 1 FROM tax_delivery_signers tds
            WHERE tds.delivery_id = td.id AND tds.signed_at IS NOT NULL
          )
        ORDER BY td.updated_at ASC
        LIMIT 50
      `, [firmId]).catch(() => ({ rows: [] })),

      // 2. Stalled messages (open, last message from client, no staff reply 48h+)
      pool.query(`
        SELECT mt.id, mt.subject, mt.last_message_at, mt.person_id,
               p.first_name, p.last_name,
               r.name AS relationship_name, r.id AS relationship_id,
               EXTRACT(DAY FROM NOW() - mt.last_message_at)::INT AS days_since,
               (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count
        FROM message_threads mt
        LEFT JOIN people p ON p.id = mt.person_id
        LEFT JOIN relationships r ON r.id = p.relationship_id
        WHERE mt.firm_id = $1
          AND mt.status = 'open'
          AND mt.last_message_at < NOW() - INTERVAL '48 hours'
          AND EXISTS (
            SELECT 1 FROM messages m
            WHERE m.thread_id = mt.id AND m.sender_type = 'client'
          )
        ORDER BY mt.last_message_at ASC
        LIMIT 10
      `, [firmId]).catch(() => ({ rows: [] })),

      // 3. Open proposals (sent or viewed, not accepted)
      pool.query(`
        SELECT id, client_name, client_email, title, engagement_type, status, created_at, viewed_at,
               EXTRACT(DAY FROM NOW() - created_at)::INT AS days_old
        FROM proposals
        WHERE firm_id = $1 AND status IN ('sent','viewed')
        ORDER BY created_at ASC
        LIMIT 10
      `, [firmId]).catch(() => ({ rows: [] })),

      // 4. MRR — read from firm_metrics cache (refreshed nightly by scheduler).
      // If nothing cached yet, kick off an async compute in the background and
      // return zeros for this load. Next dashboard load will see fresh data.
      (async () => {
        const { readMetric, computeMrrForFirm } = require('../services/metrics');
        const cached = await readMetric(firmId, 'mrr').catch(() => null);
        if (cached?.value) {
          return { rows: [{
            mrr: cached.value.mrr || 0,
            past_due: cached.value.past_due || false,
            computed_at: cached.computed_at,
          }] };
        }
        // First-time compute — fire and forget so we don't block the dashboard
        computeMrrForFirm(firmId).catch(e =>
          console.error('[dashboard] background MRR compute:', e.message)
        );
        return { rows: [{ mrr: 0, past_due: false, computed_at: null }] };
      })(),

      // 5. Portal-inactive clients (portal enabled, last login > 60 days ago or never)
      pool.query(`
        SELECT p.id, p.first_name, p.last_name, p.spouse_name, p.email,
               p.portal_last_login_at,
               r.name AS relationship_name, r.id AS relationship_id,
               CASE
                 WHEN p.portal_last_login_at IS NULL THEN NULL
                 ELSE EXTRACT(DAY FROM NOW() - p.portal_last_login_at)::INT
               END AS days_since_login
        FROM people p
        LEFT JOIN relationships r ON r.id = p.relationship_id
        WHERE p.firm_id = $1
          AND p.portal_enabled = true
          AND (
            p.portal_last_login_at IS NULL
            OR p.portal_last_login_at < NOW() - INTERVAL '60 days'
          )
        ORDER BY p.portal_last_login_at ASC NULLS LAST
        LIMIT 8
      `, [firmId]).catch(() => ({ rows: [] })),

      // 6. Engagement letters expiring in next 60 days (based on extracted term_end_date)
      pool.query(`
        SELECT el.id, el.display_name, el.created_at,
               r.id AS relationship_id, r.name AS relationship_name,
               (el.extracted_data->>'term_end_date') AS term_end_date
        FROM engagement_letters el
        JOIN relationships r ON r.id = el.relationship_id
        WHERE el.firm_id = $1
          AND el.status = 'active'
          AND el.extracted_data->>'term_end_date' IS NOT NULL
          AND (el.extracted_data->>'term_end_date')::DATE BETWEEN NOW() AND NOW() + INTERVAL '60 days'
        ORDER BY (el.extracted_data->>'term_end_date')::DATE ASC
        LIMIT 8
      `, [firmId]).catch(() => ({ rows: [] })),

      // 7. Birthdays this month
      pool.query(`
        SELECT p.id, p.first_name, p.last_name, p.spouse_name, p.date_of_birth_encrypted,
               r.name AS relationship_name, r.id AS relationship_id
        FROM people p
        LEFT JOIN relationships r ON r.id = p.relationship_id
        WHERE p.firm_id = $1
          AND p.date_of_birth_encrypted IS NOT NULL
          AND p.date_of_birth_encrypted != ''
        LIMIT 500
      `, [firmId]).catch(() => ({ rows: [] })),

      // 8. New relationships with no pipeline job (created last 30 days)
      pool.query(`
        SELECT r.id, r.name, r.created_at,
               EXTRACT(DAY FROM NOW() - r.created_at)::INT AS days_old
        FROM relationships r
        WHERE r.firm_id = $1
          AND r.created_at > NOW() - INTERVAL '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM pipeline_jobs pj
            WHERE pj.firm_id = $1 AND (
              EXISTS (SELECT 1 FROM companies c WHERE c.relationship_id = r.id AND c.id = pj.entity_id AND pj.entity_type = 'company')
              OR EXISTS (SELECT 1 FROM people pe WHERE pe.relationship_id = r.id AND pe.id = pj.entity_id AND pj.entity_type = 'person')
            )
          )
        ORDER BY r.created_at DESC
        LIMIT 8
      `, [firmId]).catch(() => ({ rows: [] })),

      // 9. CRM counts (pipeline active_jobs in separate catch to avoid zeroing core counts)
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM relationships WHERE firm_id = $1) AS relationships,
          (SELECT COUNT(*) FROM people WHERE firm_id = $1) AS people,
          (SELECT COUNT(*) FROM companies WHERE firm_id = $1) AS companies,
          (SELECT COUNT(*) FROM message_threads WHERE firm_id = $1 AND status = 'open') AS open_messages,
          (SELECT COUNT(*) FROM pipeline_jobs pj JOIN pipeline_instances pi ON pi.id = pj.instance_id WHERE pi.firm_id = $1 AND pj.job_status NOT IN ('complete','archived','done')) AS active_jobs
      `, [firmId]).catch(async () => {
        // Pipeline query may fail — retry without it so core counts still show
        const r = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM relationships WHERE firm_id = $1) AS relationships,
            (SELECT COUNT(*) FROM people WHERE firm_id = $1) AS people,
            (SELECT COUNT(*) FROM companies WHERE firm_id = $1) AS companies,
            (SELECT COUNT(*) FROM message_threads WHERE firm_id = $1 AND status = 'open') AS open_messages,
            0 AS active_jobs
        `, [firmId]).catch(() => ({ rows: [{ relationships: 0, people: 0, companies: 0, open_messages: 0, active_jobs: 0 }] }));
        return r;
      }),

      // 10. Proposal counts by month (last 6 months) for chart
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS month,
          COUNT(*) FILTER (WHERE status != 'draft') AS sent,
          COUNT(*) FILTER (WHERE status IN ('accepted','signed')) AS accepted
        FROM proposals
        WHERE firm_id = $1
          AND created_at > NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at) ASC
      `, [firmId]).catch(() => ({ rows: [] })),
    ]);

    // Process birthdays — decrypt DOBs and filter to this month
    const currentMonth = new Date().getMonth() + 1;
    const currentDay = new Date().getDate();
    const birthdayPeople = [];
    for (const person of birthdaysThisMonth.rows) {
      try {
        const dob = decrypt(person.date_of_birth_encrypted);
        if (!dob) continue;
        const dobDate = new Date(dob);
        const dobMonth = dobDate.getMonth() + 1;
        const dobDay = dobDate.getDate();
        if (dobMonth === currentMonth) {
          birthdayPeople.push({
            id: person.id,
            first_name: person.first_name,
            last_name: person.last_name,
            relationship_name: person.relationship_name,
            relationship_id: person.relationship_id,
            birthday_day: dobDay,
            is_today: dobDay === currentDay,
            is_upcoming: dobDay >= currentDay,
          });
        }
      } catch(e) { /* skip */ }
    }
    birthdayPeople.sort((a, b) => a.birthday_day - b.birthday_day);

    res.json({
      counts: counts.rows[0],
      mrr: parseFloat(mrrData.rows[0]?.mrr || 0),
      mrr_past_due: mrrData.rows[0]?.past_due || false,
      mrr_computed_at: mrrData.rows[0]?.computed_at || null,
      unsigned_returns: unsignedReturns.rows,
      stalled_messages: stalledMessages.rows,
      open_proposals: openProposals.rows,
      portal_inactive: portalInactive.rows,
      expiring_engagements: expiringEngagements.rows,
      birthdays: birthdayPeople,
      no_pipeline: noPipeline.rows,
      proposal_chart: proposalActivity.rows,
    });

  } catch (err) {
    console.error('[GET /api/dashboard/intel] error:', err);
    res.status(500).json({ error: 'Failed to load dashboard intelligence' });
  }
});

// POST /api/dashboard/refresh-mrr — synchronous Stripe pull + cache write
router.post('/refresh-mrr', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { computeMrrForFirm } = require('../services/metrics');
    const value = await computeMrrForFirm(firmId);
    res.json({ ok: true, mrr: value.mrr, past_due: value.past_due });
  } catch (err) {
    console.error('[POST /api/dashboard/refresh-mrr] error:', err);
    res.status(500).json({ error: 'Failed to refresh MRR' });
  }
});

module.exports = router;
