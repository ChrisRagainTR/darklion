'use strict';

const { pool } = require('../db');

async function auditLog(firmId, action, detail, ip) {
  try {
    await pool.query(
      'INSERT INTO audit_log (firm_id, action, detail, ip) VALUES ($1, $2, $3, $4)',
      [firmId || null, action, detail || null, ip || null]
    );
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

module.exports = { auditLog };
