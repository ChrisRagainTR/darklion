'use strict';

const { pool } = require('../db');

function boundedLimit(value, fallback = 5) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 25) : fallback;
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;
}

async function searchFirmCrm({ firmId, query, limit = 5, db = pool }) {
  const q = String(query || '').trim();
  if (!q) return { relationships: [], companies: [], people: [] };
  const resultLimit = boundedLimit(limit);
  const like = likePattern(q);

  const [relRes, compRes, peopleRes] = await Promise.all([
    db.query(`
      SELECT r.id, r.name, r.service_tier, r.billing_status, 'relationship' AS type
      FROM relationships r
      WHERE r.firm_id = $1 AND (
        r.name ILIKE $2 ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM people p
          WHERE p.relationship_id = r.id AND p.firm_id = r.firm_id
            AND (p.first_name ILIKE $2 ESCAPE '\\' OR p.last_name ILIKE $2 ESCAPE '\\'
              OR CONCAT_WS(' ', p.first_name, p.last_name) ILIKE $2 ESCAPE '\\'
              OR p.spouse_name ILIKE $2 ESCAPE '\\' OR p.email ILIKE $2 ESCAPE '\\')
        )
        OR EXISTS (
          SELECT 1 FROM companies c
          WHERE c.relationship_id = r.id AND c.firm_id = r.firm_id
            AND c.archived_at IS NULL AND c.company_name ILIKE $2 ESCAPE '\\'
        )
      )
      ORDER BY r.name ASC
      LIMIT $3
    `, [firmId, like, resultLimit]),

    db.query(`
      SELECT c.id, c.company_name AS name, c.entity_type, c.realm_id,
             c.relationship_id, r.name AS relationship_name, c.status, 'company' AS type
      FROM companies c
      LEFT JOIN relationships r ON r.id = c.relationship_id AND r.firm_id = c.firm_id
      WHERE c.firm_id = $1 AND c.company_name ILIKE $2 ESCAPE '\\' AND c.archived_at IS NULL
      ORDER BY c.company_name ASC
      LIMIT $3
    `, [firmId, like, resultLimit]),

    db.query(`
      SELECT p.id, p.first_name, p.last_name, p.spouse_name,
             NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS name,
             p.email, p.relationship_id, p.filing_status,
             r.name AS relationship_name, 'person' AS type
      FROM people p
      LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = p.firm_id
      WHERE p.firm_id = $1 AND (
        p.first_name ILIKE $2 ESCAPE '\\' OR p.last_name ILIKE $2 ESCAPE '\\'
        OR CONCAT_WS(' ', p.first_name, p.last_name) ILIKE $2 ESCAPE '\\'
        OR p.email ILIKE $2 ESCAPE '\\' OR p.spouse_name ILIKE $2 ESCAPE '\\'
        OR r.name ILIKE $2 ESCAPE '\\'
      )
      ORDER BY p.last_name ASC, p.first_name ASC
      LIMIT $3
    `, [firmId, like, resultLimit]),
  ]);

  return { relationships: relRes.rows, companies: compRes.rows, people: peopleRes.rows };
}

module.exports = { boundedLimit, likePattern, searchFirmCrm };
