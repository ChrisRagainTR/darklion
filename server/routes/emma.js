'use strict';
const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

const { getFirmContext } = require('../services/emmaContext');

// GET /api/emma/context
router.get('/context', async (req, res) => {
  try {
    const context = await getFirmContext(req.firm.id);
    res.json(context);
  } catch (err) {
    console.error('[GET /api/emma/context] error:', err);
    res.status(500).json({ error: 'Failed to load Emma context' });
  }
});

// GET /api/emma/relationship/:id — deep dive on a specific relationship (all data)
router.get('/relationship/:id', async (req, res) => {
  const firmId = req.firm.id;
  const relId = parseInt(req.params.id);
  try {
    const [rel, people, companies, engagements, threads, taxDeliveries, proposals, docs] = await Promise.all([
      // Relationship record
      pool.query('SELECT * FROM relationships WHERE id = $1 AND firm_id = $2', [relId, firmId]).catch(() => ({ rows: [] })),

      // People
      pool.query(`SELECT id, first_name, last_name, email, phone, notes, portal_enabled, portal_last_login_at, date_of_birth_encrypted
        FROM people WHERE relationship_id = $1 AND firm_id = $2`, [relId, firmId]).catch(() => ({ rows: [] })),

      // Companies
      pool.query(`SELECT id, company_name, ein, entity_type, notes
        FROM companies WHERE relationship_id = $1 AND firm_id = $2`, [relId, firmId]).catch(() => ({ rows: [] })),

      // Engagement letters with extracted contract data
      pool.query(`SELECT id, display_name, status, extracted_data, created_at
        FROM engagement_letters WHERE relationship_id = $1 AND firm_id = $2 AND status = 'active'
        ORDER BY created_at DESC LIMIT 5`, [relId, firmId]).catch(() => ({ rows: [] })),

      // Recent message threads
      pool.query(`SELECT mt.id, mt.subject, mt.status, mt.last_message_at,
               p.first_name || ' ' || p.last_name as person_name,
               (SELECT body FROM messages WHERE thread_id = mt.id ORDER BY created_at DESC LIMIT 1) as last_message,
               (SELECT sender_type FROM messages WHERE thread_id = mt.id ORDER BY created_at DESC LIMIT 1) as last_sender,
               (SELECT COUNT(*) FROM messages WHERE thread_id = mt.id AND sender_type = 'client' AND read_at IS NULL) as unread_count
        FROM message_threads mt
        LEFT JOIN people p ON p.id = mt.person_id
        WHERE mt.firm_id = $1 AND mt.person_id IN (SELECT id FROM people WHERE relationship_id = $2)
        ORDER BY mt.last_message_at DESC LIMIT 10`, [firmId, relId]).catch(() => ({ rows: [] })),

      // Tax deliveries
      pool.query(`SELECT td.id, td.tax_year, td.status, td.updated_at,
               co.company_name,
               (SELECT json_agg(json_build_object('name', p2.first_name || ' ' || p2.last_name, 'signed', tds.signed_at IS NOT NULL, 'approved', tds.approved_at IS NOT NULL))
                FROM tax_delivery_signers tds JOIN people p2 ON p2.id = tds.person_id WHERE tds.delivery_id = td.id) as signers
        FROM tax_deliveries td LEFT JOIN companies co ON co.id = td.company_id
        WHERE td.firm_id = $1 AND td.company_id IN (SELECT id FROM companies WHERE relationship_id = $2)
        ORDER BY td.created_at DESC LIMIT 10`, [firmId, relId]).catch(() => ({ rows: [] })),

      // Proposals
      pool.query(`SELECT id, client_name, engagement_type, status, created_at, viewed_at,
               (SELECT monthly_price FROM proposal_engagements WHERE proposal_id = proposals.id LIMIT 1) as monthly_price
        FROM proposals WHERE firm_id = $1
        AND (client_name IN (SELECT first_name || ' ' || last_name FROM people WHERE relationship_id = $2)
          OR id IN (SELECT proposal_id FROM proposal_engagements pe WHERE pe.firm_id = $1 LIMIT 1))
        ORDER BY created_at DESC LIMIT 5`, [firmId, relId]).catch(() => ({ rows: [] })),

      // Documents
      pool.query(`SELECT id, display_name, doc_type, year, folder_section, folder_category, created_at
        FROM documents WHERE firm_id = $1
        AND (owner_type = 'company' AND owner_id IN (SELECT id FROM companies WHERE relationship_id = $2)
          OR owner_type = 'person' AND owner_id IN (SELECT id FROM people WHERE relationship_id = $2))
        ORDER BY created_at DESC LIMIT 20`, [firmId, relId]).catch(() => ({ rows: [] })),
    ]);

    if (!rel.rows[0]) return res.status(404).json({ error: 'Relationship not found' });

    // Process engagement letter contract data
    const contractData = engagements.rows.map(e => {
      const ed = e.extracted_data || {};
      return {
        id: e.id,
        name: e.display_name,
        status: e.status,
        client_name: ed.client_name,
        entity_name: ed.entity_name,
        services: ed.services || {},
        monthly_line_items: ed.monthly_line_items || [],
        total_monthly: ed.total_monthly,
        term_end_date: ed.term_end_date,
        ai_summary: ed.ai_summary,
      };
    });

    res.json({
      relationship: rel.rows[0],
      people: people.rows,
      companies: companies.rows,
      contracts: contractData,
      messages: threads.rows,
      tax_deliveries: taxDeliveries.rows,
      proposals: proposals.rows,
      documents: docs.rows,
    });
  } catch (err) {
    console.error('[GET /api/emma/relationship/:id] error:', err);
    res.status(500).json({ error: 'Failed to load relationship data' });
  }
});

// GET /api/emma/engagement-letters — all active engagement letters with contract data
router.get('/engagement-letters', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(`
      SELECT el.id, el.display_name, el.status, el.extracted_data, el.created_at,
             r.id as relationship_id, r.name as relationship_name
      FROM engagement_letters el
      JOIN relationships r ON r.id = el.relationship_id
      WHERE el.firm_id = $1 AND el.status = 'active'
      ORDER BY el.created_at DESC
    `, [firmId]);

    const letters = rows.map(el => {
      const ed = el.extracted_data || {};
      return {
        id: el.id,
        relationship_id: el.relationship_id,
        relationship_name: el.relationship_name,
        display_name: el.display_name,
        client_name: ed.client_name,
        entity_name: ed.entity_name,
        services: ed.services || {},
        monthly_line_items: ed.monthly_line_items || [],
        total_monthly: ed.total_monthly,
        one_time_fees: ed.one_time_fees || [],
        term_end_date: ed.term_end_date,
        ai_summary: ed.ai_summary,
        created_at: el.created_at,
      };
    });

    res.json(letters);
  } catch (err) {
    console.error('[GET /api/emma/engagement-letters] error:', err);
    res.status(500).json({ error: 'Failed to fetch engagement letters' });
  }
});

// GET /api/emma/messages/:threadId — get full message thread contents
router.get('/messages/:threadId', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  try {
    const { rows: thread } = await pool.query(
      'SELECT * FROM message_threads WHERE id = $1 AND firm_id = $2',
      [threadId, firmId]
    );
    if (!thread[0]) return res.status(404).json({ error: 'Thread not found' });

    const { rows: messages } = await pool.query(
      'SELECT id, sender_type, sender_id, body, created_at, read_at FROM messages WHERE thread_id = $1 ORDER BY created_at ASC',
      [threadId]
    );

    res.json({ thread: thread[0], messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

module.exports = router;
