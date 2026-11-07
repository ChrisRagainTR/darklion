'use strict';

// Roles may overlap within a firm, but an email never chooses between firms.
async function resolveLoginFirm(email, db) {
  const { rows } = await db.query(`
    SELECT DISTINCT firm_id FROM (
      SELECT id AS firm_id FROM firms WHERE LOWER(TRIM(email)) = $1
      UNION ALL
      SELECT firm_id FROM firm_users WHERE LOWER(TRIM(email)) = $1
      UNION ALL
      SELECT firm_id FROM people
      WHERE LOWER(TRIM(email)) = $1 OR LOWER(TRIM(spouse_email)) = $1
    ) identities WHERE firm_id IS NOT NULL LIMIT 2
  `, [email]);
  return rows.length === 1 ? rows[0].firm_id : null;
}

module.exports = { resolveLoginFirm };
